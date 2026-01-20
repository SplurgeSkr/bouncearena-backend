export type QueueType = 'ranked' | 'unranked';

export interface GameState {
  ballX: number;
  ballY: number;
  ballVelX: number;
  ballVelY: number;
  ballSpeed: number;
  player1PaddleY: number;
  player2PaddleY: number;
  player1Score: number;
  player2Score: number;
  gameStarted: boolean;
  countdown: number;
  isCountingDown: boolean;
}

export interface Match {
  id: string;
  player1: {
    socketId: string;
    wallet: string;
    rating: number;
    equippedItems?: EquippedItems;
  };
  player2: {
    socketId: string;
    wallet: string;
    rating: number;
    equippedItems?: EquippedItems;
  } | null;
  queueType: QueueType;
  gameState: GameState;
  createdAt: number;
  status: 'waiting' | 'active' | 'completed' | 'cancelled';
  winner: string | null; // wallet address
  countdownTicks?: number; // Track ticks for countdown timing
  ratingChanges?: {
    player1: number;
    player2: number;
  };
}

export interface EquippedItems {
  paddle?: string;
  ball?: string;
  trail?: string;
  court?: string;
}

export interface QueuedPlayer {
  socketId: string;
  wallet: string;
  queueType: QueueType;
  rating: number;
  queuedAt: number;
  equippedItems?: EquippedItems;
}

// Rank tier definitions
export interface RankTier {
  name: string;
  minRating: number;
  maxRating: number;
  color: string;
}

export const RANK_TIERS: RankTier[] = [
  { name: 'Bronze', minRating: 0, maxRating: 999, color: '#CD7F32' },
  { name: 'Silver', minRating: 1000, maxRating: 1299, color: '#C0C0C0' },
  { name: 'Gold', minRating: 1300, maxRating: 1599, color: '#FFD700' },
  { name: 'Platinum', minRating: 1600, maxRating: 1899, color: '#00CED1' },
  { name: 'Diamond', minRating: 1900, maxRating: 2199, color: '#B9F2FF' },
  { name: 'Master', minRating: 2200, maxRating: Infinity, color: '#9945FF' },
];

export const DEFAULT_RATING = 1000;
export const PLACEMENT_GAMES = 10;
