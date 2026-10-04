//! Safe Send: a transfer that waits for the recipient.
//!
//! The sender locks SOL or SPL tokens in an escrow account tied to one recipient. Nothing reaches the
//! recipient until they verify the transfer by signing `claim_*` with the wallet it was sent to. Until then
//! the sender can `cancel_*` and get everything back, which is what saves them from a mistyped address:
//! nobody holds the key of a wrong address, so the transfer is never claimed and the sender cancels it.
//!
//! Accounts per transfer:
//! - escrow: PDA ["escrow", sender, id] with who, what and how much. For SOL it also holds the lamports.
//! - vault: PDA ["vault", escrow], an SPL token account owned by the escrow (token transfers only).
//! Rent for both always goes back to the sender, on claim or cancel.
//!
//! Token instructions box their accounts: Anchor deserializes them on the stack, which is 4 KB in SBF.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg");

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

/// Layout version written in every new escrow. Bump it when a version changes how escrows are read, so the
/// program can still handle the ones created by older versions.
pub const ESCROW_VERSION: u8 = 1;
/// Zeroed bytes at the end of each escrow for fields added later (e.g. an expiry or a fee), so adding them
/// does not resize the escrows that already exist. A new field must treat zero as "not set".
pub const ESCROW_RESERVED: usize = 64;

#[program]
pub mod safe_send {
    use super::*;

    /// Locks `amount` lamports for `recipient`. `id` is chosen by the sender (unique per sender).
    pub fn send_sol(ctx: Context<SendSol>, id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, SafeSendError::ZeroAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.escrow.set_inner(Escrow {
            sender: ctx.accounts.sender.key(),
            recipient: ctx.accounts.recipient.key(),
            mint: Pubkey::default(),
            amount,
            id,
            created_at: Clock::get()?.unix_timestamp,
            bump: ctx.bumps.escrow,
            version: ESCROW_VERSION,
            reserved: [0; ESCROW_RESERVED],
        });
        Ok(())
    }

    /// The recipient verifies the transfer: the lamports move to them, the escrow's rent back to the sender.
    pub fn claim_sol(ctx: Context<ClaimSol>) -> Result<()> {
        let amount = ctx.accounts.escrow.amount;
        let escrow = ctx.accounts.escrow.to_account_info();
        let recipient = ctx.accounts.recipient.to_account_info();
        **escrow.try_borrow_mut_lamports()? = escrow
            .lamports()
            .checked_sub(amount)
            .ok_or(SafeSendError::InsufficientEscrow)?;
        **recipient.try_borrow_mut_lamports()? = recipient
            .lamports()
            .checked_add(amount)
            .ok_or(SafeSendError::InsufficientEscrow)?;
        Ok(()) // `close = sender` returns the rest (the rent)
    }

    /// The sender takes the transfer back before it is verified: everything returns to them.
    pub fn cancel_sol(_ctx: Context<CancelSol>) -> Result<()> {
        Ok(()) // `close = sender` returns the amount and the rent
    }

    /// Locks `amount` tokens of `mint` for `recipient`. The client creates the recipient's token account in the
    /// same transaction (paid by the sender), so verifying later only costs the recipient the transaction fee.
    pub fn send_token(ctx: Context<SendToken>, id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, SafeSendError::ZeroAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
        )?;
        ctx.accounts.escrow.set_inner(Escrow {
            sender: ctx.accounts.sender.key(),
            recipient: ctx.accounts.recipient.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            id,
            created_at: Clock::get()?.unix_timestamp,
            bump: ctx.bumps.escrow,
            version: ESCROW_VERSION,
            reserved: [0; ESCROW_RESERVED],
        });
        Ok(())
    }

    /// The recipient verifies the token transfer: tokens to their account, rent back to the sender.
    pub fn claim_token(ctx: Context<ClaimToken>) -> Result<()> {
        let a = ctx.accounts;
        release_vault(
            &a.escrow,
            &a.vault,
            &a.recipient_token,
            &a.sender.to_account_info(),
            &a.token_program,
        )
    }

    /// The sender takes the token transfer back before it is verified.
    pub fn cancel_token(ctx: Context<CancelToken>) -> Result<()> {
        let a = ctx.accounts;
        release_vault(
            &a.escrow,
            &a.vault,
            &a.sender_token,
            &a.sender.to_account_info(),
            &a.token_program,
        )
    }
}

// Moves the whole vault to `to` and closes it (rent to `rent_to`), signing as the escrow PDA.
fn release_vault<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    rent_to: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let id = escrow.id.to_le_bytes();
    let seeds: &[&[u8]] = &[ESCROW_SEED, escrow.sender.as_ref(), &id, &[escrow.bump]];
    let signer = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: escrow.to_account_info(),
            },
            signer,
        ),
        escrow.amount,
    )?;
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to.clone(),
            authority: escrow.to_account_info(),
        },
        signer,
    ))
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub sender: Pubkey,
    pub recipient: Pubkey,
    /// Pubkey::default() for SOL.
    pub mint: Pubkey,
    pub amount: u64,
    pub id: u64,
    pub created_at: i64,
    pub bump: u8,
    /// ESCROW_VERSION when created.
    pub version: u8,
    /// Space for future fields, all zero today (see ESCROW_RESERVED).
    pub reserved: [u8; ESCROW_RESERVED],
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SendSol<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    /// CHECK: any address. It only has to sign the claim to receive the funds.
    #[account(constraint = recipient.key() != sender.key() @ SafeSendError::SelfTransfer)]
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init,
        payer = sender,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, sender.key().as_ref(), &id.to_le_bytes()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimSol<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    /// CHECK: checked by `has_one = sender`; gets the escrow's rent back.
    #[account(mut)]
    pub sender: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = recipient @ SafeSendError::NotRecipient,
        has_one = sender,
        constraint = escrow.mint == Pubkey::default() @ SafeSendError::WrongAsset,
        close = sender,
        seeds = [ESCROW_SEED, sender.key().as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct CancelSol<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(
        mut,
        has_one = sender @ SafeSendError::NotSender,
        constraint = escrow.mint == Pubkey::default() @ SafeSendError::WrongAsset,
        close = sender,
        seeds = [ESCROW_SEED, sender.key().as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SendToken<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    /// CHECK: any address. It only has to sign the claim to receive the tokens.
    #[account(constraint = recipient.key() != sender.key() @ SafeSendError::SelfTransfer)]
    pub recipient: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = sender)]
    pub sender_token: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = sender,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, sender.key().as_ref(), &id.to_le_bytes()],
        bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        init,
        payer = sender,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimToken<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    /// CHECK: checked by `has_one = sender`; gets the rent of the escrow and the vault back.
    #[account(mut)]
    pub sender: UncheckedAccount<'info>,
    pub mint: Box<Account<'info, Mint>>,
    // Normally created at send time by the client; created here (paid by the recipient) only if missing.
    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        has_one = recipient @ SafeSendError::NotRecipient,
        has_one = sender,
        has_one = mint @ SafeSendError::WrongAsset,
        close = sender,
        seeds = [ESCROW_SEED, sender.key().as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelToken<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = sender,
    )]
    pub sender_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        has_one = sender @ SafeSendError::NotSender,
        has_one = mint @ SafeSendError::WrongAsset,
        close = sender,
        seeds = [ESCROW_SEED, sender.key().as_ref(), &escrow.id.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum SafeSendError {
    #[msg("The amount must be greater than zero")]
    ZeroAmount,
    #[msg("You cannot send to your own wallet")]
    SelfTransfer,
    #[msg("Only the recipient can verify this transfer")]
    NotRecipient,
    #[msg("Only the sender can cancel this transfer")]
    NotSender,
    #[msg("This transfer holds a different asset")]
    WrongAsset,
    #[msg("The escrow holds less than the transfer amount")]
    InsufficientEscrow,
}
