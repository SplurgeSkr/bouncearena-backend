import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

// Solana RPC endpoint (use environment variable or default to devnet)
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

// Program ID (will be set after deployment)
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || '11111111111111111111111111111111'
);

export class SolanaService {
  private connection: Connection;
  private serverKeypair: Keypair | null = null;
  private platformStatePDA: PublicKey | null = null;

  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
    this.loadServerKeypair();
  }

  /**
   * Load server keypair from file (admin authority for submitting results)
   */
  private loadServerKeypair(): void {
    try {
      const keypairPath = process.env.SERVER_KEYPAIR_PATH || './server-keypair.json';

      if (fs.existsSync(keypairPath)) {
        const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
        this.serverKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
        console.log('Server keypair loaded:', this.serverKeypair.publicKey.toString());
      } else {
        console.warn('Server keypair not found. Generate one for production use.');
        // For development, generate a temporary keypair
        this.serverKeypair = Keypair.generate();
        console.log('Generated temporary keypair:', this.serverKeypair.publicKey.toString());
      }
    } catch (error) {
      console.error('Error loading server keypair:', error);
      this.serverKeypair = Keypair.generate();
    }
  }

  /**
   * Get Platform State PDA
   */
  private async getPlatformStatePDA(): Promise<PublicKey> {
    if (this.platformStatePDA) {
      return this.platformStatePDA;
    }

    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from('platform')],
      PROGRAM_ID
    );

    this.platformStatePDA = pda;
    return pda;
  }

  /**
   * Get Match PDA for a given match ID
   */
  private async getMatchPDA(matchId: number): Promise<[PublicKey, number]> {
    const matchIdBuffer = Buffer.alloc(8);
    matchIdBuffer.writeBigUInt64LE(BigInt(matchId));

    return await PublicKey.findProgramAddress(
      [Buffer.from('match'), matchIdBuffer],
      PROGRAM_ID
    );
  }

  /**
   * Create a new match on-chain
   * @param creator - Creator's wallet public key
   * @param betAmount - Bet amount in lamports
   * @returns Match ID
   */
  async createMatch(creator: PublicKey, betAmount: number): Promise<number> {
    try {
      console.log(`Creating match for ${creator.toString()} with bet ${betAmount} lamports`);

      // Get platform state to determine next match ID
      const platformStatePDA = await this.getPlatformStatePDA();
      const platformStateInfo = await this.connection.getAccountInfo(platformStatePDA);

      if (!platformStateInfo) {
        throw new Error('Platform not initialized. Run initialize instruction first.');
      }

      // Parse platform state to get total_matches (next match ID)
      // For now, we'll use a simple counter or timestamp as match ID
      const matchId = Date.now(); // Temporary solution

      const [matchPDA] = await this.getMatchPDA(matchId);

      console.log(`Match PDA: ${matchPDA.toString()}`);

      // In production, this would build and send a transaction to call create_match instruction
      // For now, we'll log the intent
      console.log('Match creation would be sent to blockchain here');

      return matchId;
    } catch (error) {
      console.error('Error creating match:', error);
      throw error;
    }
  }

  /**
   * Join an existing match
   * @param matchId - Match ID to join
   * @param opponent - Opponent's wallet public key
   */
  async joinMatch(matchId: number, opponent: PublicKey): Promise<void> {
    try {
      console.log(`Joining match ${matchId} as ${opponent.toString()}`);

      const [matchPDA] = await this.getMatchPDA(matchId);

      console.log(`Match PDA: ${matchPDA.toString()}`);

      // In production, build and send join_match transaction
      console.log('Match join would be sent to blockchain here');
    } catch (error) {
      console.error('Error joining match:', error);
      throw error;
    }
  }

  /**
   * Submit match result and distribute winnings
   * @param matchId - Match ID
   * @param winner - Winner's wallet public key
   */
  async submitResult(matchId: number, winner: PublicKey): Promise<void> {
    try {
      if (!this.serverKeypair) {
        throw new Error('Server keypair not loaded');
      }

      console.log(`Submitting result for match ${matchId}, winner: ${winner.toString()}`);

      const [matchPDA] = await this.getMatchPDA(matchId);
      const platformStatePDA = await this.getPlatformStatePDA();

      // In production, build submit_result transaction signed by server keypair
      console.log('Result submission would be sent to blockchain here');
      console.log('Server authority:', this.serverKeypair.publicKey.toString());

      // This would transfer:
      // - 95% of pot to winner
      // - 5% to treasury
      // - Mark match as completed
    } catch (error) {
      console.error('Error submitting result:', error);
      throw error;
    }
  }

  /**
   * Cancel a match and refund creator
   * @param matchId - Match ID
   * @param creator - Creator's wallet public key
   */
  async cancelMatch(matchId: number, creator: PublicKey): Promise<void> {
    try {
      console.log(`Cancelling match ${matchId} for ${creator.toString()}`);

      const [matchPDA] = await this.getMatchPDA(matchId);

      // In production, build cancel_match transaction
      console.log('Match cancellation would be sent to blockchain here');
    } catch (error) {
      console.error('Error cancelling match:', error);
      throw error;
    }
  }

  /**
   * Get SOL balance for a wallet
   * @param publicKey - Wallet public key
   * @returns Balance in SOL
   */
  async getBalance(publicKey: PublicKey): Promise<number> {
    try {
      const balance = await this.connection.getBalance(publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('Error getting balance:', error);
      return 0;
    }
  }

  /**
   * Verify a transaction signature
   * @param signature - Transaction signature
   * @returns True if confirmed
   */
  async verifyTransaction(signature: string): Promise<boolean> {
    try {
      const status = await this.connection.getSignatureStatus(signature);
      return status?.value?.confirmationStatus === 'confirmed' ||
             status?.value?.confirmationStatus === 'finalized';
    } catch (error) {
      console.error('Error verifying transaction:', error);
      return false;
    }
  }

  /**
   * Initialize platform (one-time setup)
   * @param admin - Admin wallet public key
   * @param treasury - Treasury wallet public key
   */
  async initializePlatform(admin: PublicKey, treasury: PublicKey): Promise<void> {
    try {
      console.log('Initializing platform...');
      console.log('Admin:', admin.toString());
      console.log('Treasury:', treasury.toString());

      const platformStatePDA = await this.getPlatformStatePDA();

      // Check if already initialized
      const platformStateInfo = await this.connection.getAccountInfo(platformStatePDA);
      if (platformStateInfo) {
        console.log('Platform already initialized');
        return;
      }

      // In production, build and send initialize transaction
      console.log('Platform initialization would be sent to blockchain here');
    } catch (error) {
      console.error('Error initializing platform:', error);
      throw error;
    }
  }
}

// Singleton instance
export const solanaService = new SolanaService();
