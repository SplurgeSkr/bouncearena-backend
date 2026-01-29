import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { GameManager } from './game/GameManager';
import { MatchmakingService } from './services/MatchmakingService';
import { calculateEloChange, getRankTier } from './utils/elo';
import { v4 as uuidv4 } from 'uuid';
import { QueueType, DEFAULT_RATING, PLACEMENT_GAMES } from './game/types';
import crypto from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { getPlayerRating, updatePlayerAfterMatch, recordMatch, getPlayerPurchases, saveEquippedItems, getEquippedItems } from './services/SupabaseService';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Allowed origins for CORS - production domains only
const ALLOWED_ORIGINS = [
  'https://frontend-ashen-zeta-17.vercel.app',
  'https://bouncearena.vercel.app', // Add your custom domain if you have one
  process.env.FRONTEND_URL, // Allow override via env
].filter(Boolean) as string[];

// Add localhost for development
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:19006', 'http://localhost:8081');
}

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));
app.use(express.json());

// Rate limiting map
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per window

function checkRateLimit(identifier: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(identifier);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(identifier, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// Services
const gameManager = new GameManager();
const matchmaking = new MatchmakingService();

// In-memory player data store (replace with Supabase in production)
const playerData: Map<string, { rating: number; placementGames: number }> = new Map();

// Authenticated socket sessions: socketId -> wallet
const authenticatedSockets: Map<string, string> = new Map();

// Active matches: matchId -> { player1SocketId, player2SocketId }
const activeMatches: Map<string, { player1SocketId: string; player2SocketId: string }> = new Map();

// Input validation helpers
function isValidWalletAddress(wallet: string): boolean {
  // Solana addresses are base58 encoded and 32-44 characters
  if (!wallet || typeof wallet !== 'string') return false;
  if (wallet.length < 32 || wallet.length > 44) return false;
  // Base58 character set (no 0, O, I, l)
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(wallet);
}

function isValidQueueType(queueType: string): queueType is QueueType {
  return queueType === 'unranked' || queueType === 'ranked';
}

function isValidEquippedItems(items: any): boolean {
  if (!items) return true; // Optional field
  if (typeof items !== 'object') return false;

  // Validate each item category
  const validCategories = ['ball', 'paddle', 'court', 'trail'];
  for (const key of Object.keys(items)) {
    if (!validCategories.includes(key)) return false;
    if (items[key] && typeof items[key] !== 'string') return false;
    // Item IDs should be reasonable length
    if (items[key] && items[key].length > 50) return false;
  }
  return true;
}

function isValidPaddleY(paddleY: number): boolean {
  return typeof paddleY === 'number' && paddleY >= 0 && paddleY <= 450 && !isNaN(paddleY);
}

function isValidMatchId(matchId: string): boolean {
  // UUID v4 format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return typeof matchId === 'string' && uuidRegex.test(matchId);
}

// Helper to get or create player data (sync, uses in-memory cache)
function getPlayerData(wallet: string) {
  if (!playerData.has(wallet)) {
    playerData.set(wallet, { rating: DEFAULT_RATING, placementGames: 0 });
  }
  return playerData.get(wallet)!;
}

// Load player data from Supabase into in-memory cache
async function loadPlayerData(wallet: string) {
  if (playerData.has(wallet)) return getPlayerData(wallet);
  const dbData = await getPlayerRating(wallet);
  if (dbData) {
    playerData.set(wallet, dbData);
    return dbData;
  }
  return getPlayerData(wallet);
}

// Check if socket is authorized for a match
function isSocketAuthorizedForMatch(socketId: string, matchId: string): boolean {
  const matchSockets = activeMatches.get(matchId);
  if (!matchSockets) return false;
  return matchSockets.player1SocketId === socketId || matchSockets.player2SocketId === socketId;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    queueStats: matchmaking.getQueueStats(),
  });
});

// Debug: test Supabase connectivity
app.get('/debug/supabase', async (_req, res) => {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_KEY || '';
    if (!key) {
      return res.json({ error: 'SUPABASE_KEY not set', url, keyLength: 0 });
    }
    const client = createClient(url, key);
    const { data, error } = await client.from('leaderboard').select('*').limit(1);
    res.json({ success: !error, url, keyLength: key.length, keyPrefix: key.substring(0, 10), data, error: error?.message });
  } catch (e: any) {
    res.json({ error: e.message });
  }
});

// Get player rating (for frontend)
app.get('/player/:wallet', (req, res) => {
  const { wallet } = req.params;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const data = getPlayerData(wallet);
  res.json({
    wallet,
    rating: data.rating,
    rankTier: getRankTier(data.rating),
    placementGames: data.placementGames,
    isPlacement: data.placementGames < PLACEMENT_GAMES,
  });
});

// Get purchased items for a wallet
app.get('/purchases/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const itemIds = await getPlayerPurchases(wallet);
    res.json({ items: itemIds });
  } catch (error: any) {
    console.error('Failed to fetch purchases:', error);
    res.status(500).json({ error: 'Failed to fetch purchases' });
  }
});

// Get equipped items for a wallet
app.get('/equipped/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  try {
    const equipped = await getEquippedItems(wallet);
    res.json({ equipped: equipped || null });
  } catch (error: any) {
    console.error('Failed to fetch equipped items:', error);
    res.status(500).json({ error: 'Failed to fetch equipped items' });
  }
});

// Save equipped items for a wallet
app.post('/equipped/:wallet', async (req, res) => {
  const { wallet } = req.params;
  const { equippedItems } = req.body;

  if (!isValidWalletAddress(wallet)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (!isValidEquippedItems(equippedItems)) {
    return res.status(400).json({ error: 'Invalid equipped items' });
  }

  try {
    await saveEquippedItems(wallet, equippedItems);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Failed to save equipped items:', error);
    res.status(500).json({ error: 'Failed to save equipped items' });
  }
});

// Verify purchase on-chain
app.post('/verify-purchase', async (req, res) => {
  try {
    const { signature, itemId, buyerWallet, amountSol } = req.body;

    if (!signature || !itemId || !buyerWallet) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!isValidWalletAddress(buyerWallet)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Verify transaction on-chain
    const { Connection } = await import('@solana/web3.js');
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=b016d994-f308-4924-8dfb-b016057b8f5b';
    const connection = new Connection(rpcUrl, 'confirmed');

    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (tx.meta?.err) {
      return res.status(400).json({ error: 'Transaction failed on-chain' });
    }

    // Record in Supabase
    const { recordPurchase } = await import('./services/SupabaseService');
    await recordPurchase(buyerWallet, itemId, signature, amountSol || 0, true);

    res.json({ verified: true, signature });
  } catch (error: any) {
    console.error('Purchase verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Socket.io connection handling
io.on('connection', (socket: Socket) => {
  console.log('Client connected:', socket.id);

  const clientIp = socket.handshake.address;

  // Rate limit check on connection
  if (!checkRateLimit(clientIp)) {
    console.log('Rate limit exceeded for:', clientIp);
    socket.emit('error', { message: 'Rate limit exceeded. Please try again later.' });
    socket.disconnect(true);
    return;
  }

  // Authenticate wallet - must be called before other actions
  socket.on('authenticate', ({ wallet, signature, message }: {
    wallet: string;
    signature: string;
    message: string;
  }) => {
    if (!checkRateLimit(socket.id)) {
      socket.emit('error', { message: 'Rate limit exceeded' });
      return;
    }

    if (!isValidWalletAddress(wallet)) {
      socket.emit('auth_error', { message: 'Invalid wallet address' });
      return;
    }

    // Verify the wallet signature using tweetnacl
    try {
      const messageBytes = new TextEncoder().encode(message);
      // Frontend sends signature as hex string
      const signatureBytes = Buffer.from(signature, 'hex');
      const publicKeyBytes = bs58.decode(wallet);

      const isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKeyBytes
      );

      if (!isValid) {
        socket.emit('auth_error', { message: 'Invalid signature' });
        console.warn(`Invalid signature from ${wallet}`);
        return;
      }
    } catch (e) {
      console.error('Signature verification error:', e);
      socket.emit('auth_error', { message: 'Signature verification failed' });
      return;
    }

    // Store authenticated session
    authenticatedSockets.set(socket.id, wallet);
    socket.emit('authenticated', { wallet });
    console.log(`Wallet ${wallet} authenticated for socket ${socket.id}`);
  });

  // Join matchmaking queue
  socket.on('join_queue', ({ wallet, queueType, equippedItems }: {
    wallet: string;
    queueType: QueueType;
    equippedItems?: any
  }) => {
    if (!checkRateLimit(socket.id)) {
      socket.emit('error', { message: 'Rate limit exceeded' });
      return;
    }

    // Validate inputs
    if (!isValidWalletAddress(wallet)) {
      socket.emit('error', { message: 'Invalid wallet address' });
      return;
    }

    if (!isValidQueueType(queueType)) {
      socket.emit('error', { message: 'Invalid queue type' });
      return;
    }

    if (!isValidEquippedItems(equippedItems)) {
      socket.emit('error', { message: 'Invalid equipped items' });
      return;
    }

    // Authentication check (optional - log warning if not authenticated)
    const authenticatedWallet = authenticatedSockets.get(socket.id);
    if (!authenticatedWallet) {
      console.warn(`Wallet ${wallet} joining queue without authentication`);
    } else if (authenticatedWallet !== wallet) {
      socket.emit('error', { message: 'Wallet mismatch with authenticated session' });
      return;
    }

    // Get player's current rating
    const player = getPlayerData(wallet);

    console.log(`Player ${wallet} (${player.rating} MMR) joining ${queueType} queue`);

    const opponent = matchmaking.addToQueue({
      socketId: socket.id,
      wallet,
      queueType,
      rating: player.rating,
      queuedAt: Date.now(),
      equippedItems,
    });

    if (opponent) {
      // Match found!
      const matchId = uuidv4();
      const opponentData = getPlayerData(opponent.wallet);

      console.log(`Match found! ${wallet} (${player.rating}) vs ${opponent.wallet} (${opponentData.rating})`);

      // Track active match participants
      activeMatches.set(matchId, {
        player1SocketId: opponent.socketId,
        player2SocketId: socket.id,
      });

      // Create match in game manager
      const match = gameManager.createMatch(
        matchId,
        opponent.socketId,
        opponent.wallet,
        opponentData.rating,
        queueType,
        opponent.equippedItems
      );
      gameManager.joinMatch(matchId, socket.id, wallet, player.rating, equippedItems);

      // Notify both players
      io.to(opponent.socketId).emit('match_found', {
        matchId,
        opponent: wallet,
        opponentRating: player.rating,
        playerNumber: 1,
        queueType,
        opponentEquippedItems: equippedItems,
      });

      socket.emit('match_found', {
        matchId,
        opponent: opponent.wallet,
        opponentRating: opponentData.rating,
        playerNumber: 2,
        queueType,
        opponentEquippedItems: opponent.equippedItems,
      });

      // Start game loop after a short delay
      setTimeout(() => {
        gameManager.startGameLoop(
          matchId,
          (gameState) => {
            // Send game state to both players
            io.to(opponent.socketId).emit('game_state_update', gameState);
            io.to(socket.id).emit('game_state_update', gameState);
          },
          (winnerWallet) => {
            // Game ended
            const finalMatch = gameManager.getMatch(matchId);
            if (!finalMatch || !finalMatch.player2) return;

            const player1Wallet = finalMatch.player1.wallet;
            const player2Wallet = finalMatch.player2.wallet;
            const player1Data = getPlayerData(player1Wallet);
            const player2Data = getPlayerData(player2Wallet);

            let ratingChanges = { player1: 0, player2: 0 };

            // Only update ratings for ranked matches
            if (queueType === 'ranked') {
              const isPlayer1Winner = winnerWallet === player1Wallet;
              const winnerRating = isPlayer1Winner ? player1Data.rating : player2Data.rating;
              const loserRating = isPlayer1Winner ? player2Data.rating : player1Data.rating;
              const winnerPlacement = isPlayer1Winner ? player1Data.placementGames : player2Data.placementGames;
              const loserPlacement = isPlayer1Winner ? player2Data.placementGames : player1Data.placementGames;

              const changes = calculateEloChange(winnerRating, loserRating, winnerPlacement, loserPlacement);

              if (isPlayer1Winner) {
                ratingChanges.player1 = changes.winnerChange;
                ratingChanges.player2 = changes.loserChange;
              } else {
                ratingChanges.player1 = changes.loserChange;
                ratingChanges.player2 = changes.winnerChange;
              }

              // Apply rating changes
              player1Data.rating = Math.max(0, player1Data.rating + ratingChanges.player1);
              player2Data.rating = Math.max(0, player2Data.rating + ratingChanges.player2);

              // Increment placement games
              if (player1Data.placementGames < PLACEMENT_GAMES) player1Data.placementGames++;
              if (player2Data.placementGames < PLACEMENT_GAMES) player2Data.placementGames++;

              console.log(`Rating changes: ${player1Wallet}: ${ratingChanges.player1 > 0 ? '+' : ''}${ratingChanges.player1}, ${player2Wallet}: ${ratingChanges.player2 > 0 ? '+' : ''}${ratingChanges.player2}`);
            }

            // Notify both players of match end
            io.to(opponent.socketId).emit('match_ended', {
              winner: winnerWallet,
              player1Score: finalMatch.gameState.player1Score,
              player2Score: finalMatch.gameState.player2Score,
              queueType,
              ratingChange: ratingChanges.player1,
              newRating: player1Data.rating,
            });

            io.to(socket.id).emit('match_ended', {
              winner: winnerWallet,
              player1Score: finalMatch.gameState.player1Score,
              player2Score: finalMatch.gameState.player2Score,
              queueType,
              ratingChange: ratingChanges.player2,
              newRating: player2Data.rating,
            });

            // Clean up active match
            activeMatches.delete(matchId);

            // Persist to Supabase (fire-and-forget)
            const isP1Winner = winnerWallet === player1Wallet;
            updatePlayerAfterMatch(player1Wallet, player1Data.rating, isP1Winner, 0, 0).catch((e) => console.error('Supabase error:', e));
            updatePlayerAfterMatch(player2Wallet, player2Data.rating, !isP1Winner, 0, 0).catch((e) => console.error('Supabase error:', e));
            recordMatch(
              matchId, player1Wallet, player2Wallet, winnerWallet,
              finalMatch.gameState.player1Score, finalMatch.gameState.player2Score,
              queueType, ratingChanges.player1, ratingChanges.player2
            ).catch((e) => console.error('Supabase error:', e));

            console.log(`Match ${matchId} ended. Winner: ${winnerWallet}`);
          }
        );
      }, 3000); // 3 second delay before game starts
    } else {
      // Waiting for opponent
      socket.emit('searching', { queueType, rating: player.rating });
      console.log(`Player ${wallet} waiting in ${queueType} queue`);
    }
  });

  // Leave matchmaking queue
  socket.on('leave_queue', () => {
    const removed = matchmaking.removeFromQueue(socket.id);
    if (removed) {
      console.log(`Player ${socket.id} left queue`);
      socket.emit('queue_left');
    }
  });

  // Update paddle position
  socket.on('update_paddle', ({ matchId, paddleY }: { matchId: string; paddleY: number }) => {
    // Validate inputs
    if (!isValidMatchId(matchId)) {
      return; // Silently ignore invalid match IDs for performance
    }

    if (!isValidPaddleY(paddleY)) {
      return; // Silently ignore invalid paddle positions
    }

    // Check authorization
    if (!isSocketAuthorizedForMatch(socket.id, matchId)) {
      return; // Not authorized for this match
    }

    const match = gameManager.getMatch(matchId);
    if (!match) return;

    const playerNumber = match.player1.socketId === socket.id ? 1 : 2;
    gameManager.updatePaddle(matchId, playerNumber as 1 | 2, paddleY);
  });

  // Cancel match - only allowed by participants
  socket.on('cancel_match', ({ matchId }: { matchId: string }) => {
    if (!isValidMatchId(matchId)) {
      socket.emit('error', { message: 'Invalid match ID' });
      return;
    }

    // Check authorization
    if (!isSocketAuthorizedForMatch(socket.id, matchId)) {
      socket.emit('error', { message: 'Not authorized to cancel this match' });
      return;
    }

    const matchSockets = activeMatches.get(matchId);
    if (matchSockets) {
      // Notify both players
      io.to(matchSockets.player1SocketId).emit('match_cancelled', { reason: 'Player left' });
      io.to(matchSockets.player2SocketId).emit('match_cancelled', { reason: 'Player left' });
      activeMatches.delete(matchId);
    }

    gameManager.cancelMatch(matchId);
  });

  // Get player rating
  socket.on('get_rating', async ({ wallet }: { wallet: string }) => {
    if (!isValidWalletAddress(wallet)) {
      socket.emit('error', { message: 'Invalid wallet address' });
      return;
    }

    const data = await loadPlayerData(wallet);
    socket.emit('player_rating', {
      rating: data.rating,
      rankTier: getRankTier(data.rating),
      placementGames: data.placementGames,
      isPlacement: data.placementGames < PLACEMENT_GAMES,
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Remove from queue
    matchmaking.removeFromQueue(socket.id);

    // Remove from authenticated sessions
    authenticatedSockets.delete(socket.id);

    // Handle active match disconnection
    for (const [matchId, matchSockets] of activeMatches.entries()) {
      if (matchSockets.player1SocketId === socket.id || matchSockets.player2SocketId === socket.id) {
        const opponentSocketId = matchSockets.player1SocketId === socket.id
          ? matchSockets.player2SocketId
          : matchSockets.player1SocketId;

        // Notify opponent
        io.to(opponentSocketId).emit('opponent_disconnected', { matchId });

        // Get match to determine winner (opponent wins by default)
        const match = gameManager.getMatch(matchId);
        if (match && match.player2) {
          const disconnectedWallet = match.player1.socketId === socket.id
            ? match.player1.wallet
            : match.player2.wallet;
          const winnerWallet = match.player1.socketId === socket.id
            ? match.player2.wallet
            : match.player1.wallet;

          console.log(`Player ${disconnectedWallet} disconnected. ${winnerWallet} wins by forfeit.`);

          // Calculate rating changes for forfeit (ranked matches only)
          let ratingChange = 0;
          let newRating = 0;
          if (match.queueType === 'ranked') {
            const winnerData = getPlayerData(winnerWallet);
            const loserData = getPlayerData(disconnectedWallet);
            const changes = calculateEloChange(
              winnerData.rating, loserData.rating,
              winnerData.placementGames, loserData.placementGames
            );
            winnerData.rating = Math.max(0, winnerData.rating + changes.winnerChange);
            loserData.rating = Math.max(0, loserData.rating + changes.loserChange);
            if (winnerData.placementGames < PLACEMENT_GAMES) winnerData.placementGames++;
            if (loserData.placementGames < PLACEMENT_GAMES) loserData.placementGames++;
            ratingChange = changes.winnerChange;
            newRating = winnerData.rating;
            console.log(`Forfeit rating: ${winnerWallet} +${changes.winnerChange}, ${disconnectedWallet} ${changes.loserChange}`);
          }

          // End match with opponent as winner
          io.to(opponentSocketId).emit('match_ended', {
            winner: winnerWallet,
            player1Score: match.gameState.player1Score,
            player2Score: match.gameState.player2Score,
            queueType: match.queueType,
            ratingChange,
            newRating,
            forfeit: true,
          });

          // Persist forfeit to Supabase
          if (match.queueType === 'ranked') {
            const wd = getPlayerData(winnerWallet);
            const ld = getPlayerData(disconnectedWallet);
            updatePlayerAfterMatch(winnerWallet, wd.rating, true, 0, 0).catch((e) => console.error('Supabase error:', e));
            updatePlayerAfterMatch(disconnectedWallet, ld.rating, false, 0, 0).catch((e) => console.error('Supabase error:', e));
          }
          recordMatch(
            matchId, match.player1.wallet, match.player2.wallet, winnerWallet,
            match.gameState.player1Score, match.gameState.player2Score,
            match.queueType, ratingChange, -(ratingChange)
          ).catch((e) => console.error('Supabase error:', e));
        }

        // Clean up
        gameManager.cancelMatch(matchId);
        activeMatches.delete(matchId);
        break;
      }
    }
  });
});

// Cleanup expired queue entries every 10 seconds
setInterval(() => {
  matchmaking.cleanupExpiredPlayers((player) => {
    io.to(player.socketId).emit('queue_timeout');
    console.log(`Player ${player.wallet} timed out from queue`);
  });
}, 10000);

// Cleanup rate limit map every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 60000);

// Start server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
