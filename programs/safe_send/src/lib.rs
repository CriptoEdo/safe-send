//! Safe Send: a transfer that waits for the recipient.
//!
//! The sender locks SOL or SPL tokens in an escrow account tied to one recipient. Nothing reaches the
//! recipient until they verify the transfer by signing `claim_*` with the wallet it was sent to. Until then
//! the sender can `cancel_*` and get everything back, which is what saves them from a mistyped address:
//! nobody holds the key of a wrong address, so the transfer is never claimed and the sender cancels it.
//!
//! Accounts per transfer:
//! - escrow: PDA ["escrow", sender, id] with who, what and how much. For SOL it also holds the lamports.
//! - vault: PDA ["vault", escrow], a token account owned by the escrow (token transfers only).
//! Rent for both always goes back to the sender, on claim or cancel.
//!
//! Tokens of both the SPL Token program and Token-2022 are supported. Token-2022 extensions that could lock
//! funds in an escrow are handled:
//! - transfer fee: the escrow records what actually reached the vault, the release moves the vault's whole
//!   balance, and the fees withheld in the vault are harvested to the mint (otherwise it could not be closed);
//! - permanent delegate: the issuer can move tokens out of the vault, so the release moves what is left;
//! - transfer hook: refused at send time, since a hook program (even one added later) could block the release.
//! Extensions that make the deposit itself fail (non-transferable, frozen by default, CPI guard) fail the send
//! transaction as a whole, so nothing gets locked.
//!
//! Fees: a Config PDA ["config"] holds an optional fee per send, paid by the sender on top of the amount and
//! moved to the treasury at send time (not refunded on cancel): `fee_bps` of the amount (in SOL, or in the
//! token sent) plus `flat_fee_lamports` in SOL. Both start at zero and the admin changes them with
//! `update_config`, within MAX_FEE_BPS and MAX_FLAT_FEE_LAMPORTS. Only the program's upgrade authority can
//! create the Config, so nobody else can claim the admin role first.
//!
//! Token instructions box their accounts: Anchor deserializes them on the stack, which is 4 KB in SBF.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig, transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_interface::{
    self, CloseAccount, HarvestWithheldTokensToMint, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("EGLwJZkWybKNMeQQcmJ6HZYnCfTqWn2b7RQVRsPsQ1Zg");

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CONFIG_SEED: &[u8] = b"config";

/// Upper bounds of the fees, fixed in the code: the admin can never charge more (1% and 0.01 SOL).
pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_FLAT_FEE_LAMPORTS: u64 = 10_000_000;

/// Layout version written in every new escrow. Bump it when a version changes how escrows are read, so the
/// program can still handle the ones created by older versions.
pub const ESCROW_VERSION: u8 = 1;
/// Zeroed bytes at the end of each escrow for fields added later (e.g. an expiry or a fee), so adding them
/// does not resize the escrows that already exist. A new field must treat zero as "not set".
pub const ESCROW_RESERVED: usize = 64;

#[program]
pub mod safe_send {
    use super::*;

    /// Creates the fee configuration, with no fees. Only the program's upgrade authority can call it, once;
    /// it becomes the admin.
    pub fn initialize_config(ctx: Context<InitializeConfig>, treasury: Pubkey) -> Result<()> {
        ctx.accounts.config.set_inner(Config {
            admin: ctx.accounts.authority.key(),
            treasury,
            fee_bps: 0,
            flat_fee_lamports: 0,
            bump: ctx.bumps.config,
            reserved: [0; CONFIG_RESERVED],
        });
        Ok(())
    }

    /// The admin sets the fees, the treasury and the admin itself (e.g. hand it to a multisig).
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        admin: Pubkey,
        treasury: Pubkey,
        fee_bps: u16,
        flat_fee_lamports: u64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, SafeSendError::FeeTooHigh);
        require!(flat_fee_lamports <= MAX_FLAT_FEE_LAMPORTS, SafeSendError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.treasury = treasury;
        config.fee_bps = fee_bps;
        config.flat_fee_lamports = flat_fee_lamports;
        Ok(())
    }

    /// Locks `amount` lamports for `recipient`. `id` is chosen by the sender (unique per sender). The fee, if
    /// any, is paid on top and goes to the treasury now.
    pub fn send_sol(ctx: Context<SendSol>, id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, SafeSendError::ZeroAmount);
        let fee = ctx.accounts.config.percent_fee(amount)?
            .checked_add(ctx.accounts.config.flat_fee_lamports)
            .ok_or(SafeSendError::FeeTooHigh)?;
        pay_lamports(&ctx.accounts.system_program, &ctx.accounts.sender, &ctx.accounts.treasury, fee)?;
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
        require!(
            !token_2022_rules(&ctx.accounts.mint.to_account_info())?.transfer_hook,
            SafeSendError::UnsupportedToken
        );
        // Fees on top: a share of the tokens to the treasury's token account, the flat fee in SOL.
        let token_fee = ctx.accounts.config.percent_fee(amount)?;
        if token_fee > 0 {
            let treasury_token = ctx.accounts.treasury_token.as_ref().ok_or(SafeSendError::MissingTreasuryAccount)?;
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.sender_token.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: treasury_token.to_account_info(),
                        authority: ctx.accounts.sender.to_account_info(),
                    },
                ),
                token_fee,
                ctx.accounts.mint.decimals,
            )?;
        }
        let flat_fee = ctx.accounts.config.flat_fee_lamports;
        pay_lamports(&ctx.accounts.system_program, &ctx.accounts.sender, &ctx.accounts.treasury, flat_fee)?;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.sender_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        // With a transfer fee the vault receives less than `amount`: the escrow records what actually arrived.
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount;
        require!(received > 0, SafeSendError::ZeroAmount);
        ctx.accounts.escrow.set_inner(Escrow {
            sender: ctx.accounts.sender.key(),
            recipient: ctx.accounts.recipient.key(),
            mint: ctx.accounts.mint.key(),
            amount: received,
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
            &a.mint,
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
            &a.mint,
            &a.sender_token,
            &a.sender.to_account_info(),
            &a.token_program,
        )
    }
}

// The upgrade authority stored in a ProgramData account: a u32 tag (3 = ProgramData), the deploy slot (u64),
// then an Option<Pubkey> (1-byte flag + 32 bytes). Read by hand to avoid pulling bincode into the program.
fn upgrade_authority(program_data: &AccountInfo) -> Result<Option<Pubkey>> {
    let data = program_data.try_borrow_data()?;
    require!(data.len() >= 45 && data[..4] == 3u32.to_le_bytes(), SafeSendError::NotAdmin);
    Ok(match data[12] {
        1 => Some(Pubkey::try_from(&data[13..45]).map_err(|_| error!(SafeSendError::NotAdmin))?),
        _ => None,
    })
}

fn pay_lamports<'info>(
    system_program: &Program<'info, System>,
    from: &Signer<'info>,
    to: &UncheckedAccount<'info>,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            system_program::Transfer { from: from.to_account_info(), to: to.to_account_info() },
        ),
        lamports,
    )
}

/// The Token-2022 extensions of a mint that change how an escrow works (all false for SPL Token mints).
struct Token2022Rules {
    /// Transfers withhold a fee in the receiving account; it must be harvested before the vault is closed.
    transfer_fee: bool,
    /// A hook program runs on every transfer, or can be set later by the hook authority.
    transfer_hook: bool,
}

fn token_2022_rules(mint: &AccountInfo) -> Result<Token2022Rules> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(Token2022Rules { transfer_fee: false, transfer_hook: false });
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    let transfer_hook = match state.get_extension::<TransferHook>() {
        Ok(hook) => {
            Option::<Pubkey>::from(hook.program_id).is_some() || Option::<Pubkey>::from(hook.authority).is_some()
        }
        Err(_) => false,
    };
    Ok(Token2022Rules { transfer_fee: state.get_extension::<TransferFeeConfig>().is_ok(), transfer_hook })
}

// Moves everything in the vault to `to` and closes it (rent to `rent_to`), signing as the escrow PDA. The whole
// balance, not `escrow.amount`: with a permanent delegate the issuer may have moved tokens out meanwhile.
fn release_vault<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    rent_to: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let id = escrow.id.to_le_bytes();
    let seeds: &[&[u8]] = &[ESCROW_SEED, escrow.sender.as_ref(), &id, &[escrow.bump]];
    let signer = &[seeds];
    if vault.amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to: to.to_account_info(),
                    authority: escrow.to_account_info(),
                },
                signer,
            ),
            vault.amount,
            mint.decimals,
        )?;
    }
    // Fees withheld in the vault when it received the tokens would block closing it: move them to the mint
    // (permissionless; the client passes the mint as writable for these tokens).
    if token_2022_rules(&mint.to_account_info())?.transfer_fee {
        token_interface::harvest_withheld_tokens_to_mint(
            CpiContext::new(
                token_program.to_account_info(),
                HarvestWithheldTokensToMint {
                    token_program_id: token_program.to_account_info(),
                    mint: mint.to_account_info(),
                },
            ),
            vec![vault.to_account_info()],
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to.clone(),
            authority: escrow.to_account_info(),
        },
        signer,
    ))
}

/// Zeroed bytes at the end of the Config for settings added later (zero = "not set").
pub const CONFIG_RESERVED: usize = 64;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Can change everything here with `update_config` (a wallet, or a multisig).
    pub admin: Pubkey,
    /// Receives the fees: SOL directly, tokens in its token accounts.
    pub treasury: Pubkey,
    /// Fee in basis points of the amount sent (30 = 0.3%), paid in what is sent. At most MAX_FEE_BPS.
    pub fee_bps: u16,
    /// Fixed fee in lamports per send. At most MAX_FLAT_FEE_LAMPORTS.
    pub flat_fee_lamports: u64,
    pub bump: u8,
    pub reserved: [u8; CONFIG_RESERVED],
}

impl Config {
    /// `fee_bps` of `amount`, rounded down.
    pub fn percent_fee(&self, amount: u64) -> Result<u64> {
        let fee = (amount as u128) * (self.fee_bps as u128) / 10_000;
        u64::try_from(fee).map_err(|_| error!(SafeSendError::FeeTooHigh))
    }
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
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: this program's ProgramData account (address checked); its upgrade authority is read by hand.
    #[account(
        address = Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0,
        constraint = upgrade_authority(&program_data)? == Some(authority.key()) @ SafeSendError::NotAdmin,
    )]
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SafeSendError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SendSol<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    /// CHECK: any address. It only has to sign the claim to receive the funds.
    #[account(constraint = recipient.key() != sender.key() @ SafeSendError::SelfTransfer)]
    pub recipient: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: the treasury in the config; receives the fee.
    #[account(mut, address = config.treasury @ SafeSendError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
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
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = sender, token::token_program = token_program)]
    pub sender_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the treasury in the config; receives the flat fee.
    #[account(mut, address = config.treasury @ SafeSendError::WrongTreasury)]
    pub treasury: UncheckedAccount<'info>,
    /// The treasury's account for this token; needed only when there is a percentage fee.
    #[account(
        mut,
        token::mint = mint,
        token::authority = config.treasury,
        token::token_program = token_program,
    )]
    pub treasury_token: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
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
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimToken<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,
    /// CHECK: checked by `has_one = sender`; gets the rent of the escrow and the vault back.
    #[account(mut)]
    pub sender: UncheckedAccount<'info>,
    /// Writable only for mints with a transfer fee (the withheld fees are harvested to it).
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    // Normally created at send time by the client; created here (paid by the recipient) only if missing.
    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token: Box<InterfaceAccount<'info, TokenAccount>>,
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
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelToken<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    /// Writable only for mints with a transfer fee (the withheld fees are harvested to it).
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = sender,
        associated_token::token_program = token_program,
    )]
    pub sender_token: Box<InterfaceAccount<'info, TokenAccount>>,
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
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
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
    #[msg("Tokens with a transfer hook are not supported")]
    UnsupportedToken,
    #[msg("Only the admin can change the configuration")]
    NotAdmin,
    #[msg("The fee is above the maximum allowed")]
    FeeTooHigh,
    #[msg("The treasury account does not match the configuration")]
    WrongTreasury,
    #[msg("The treasury's token account is required when there is a percentage fee")]
    MissingTreasuryAccount,
}
