import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { GameManager } from './game/GameManager';
import { MatchmakingService } from './services/MatchmakingService';
import { calculateEloChange, getRankTier } from './utils/elo';
import { v4 as uuidv4 } from 'uuid';
import { QueueType, DEFAULT_RATING, PLACEMENT_GAMES } from './game/types';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // Allow all origins for development/mobile testing
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Services
const gameManager = new GameManager();
const matchmaking = new MatchmakingService();

// In-memory player data store (replace with Supabase in production)
const playerData: Map<string, { rating: number; placementGames: number }> = new Map();

// Helper to get or create player data
function getPlayerData(wallet: string) {
  if (!playerData.has(wallet)) {
    playerData.set(wallet, { rating: DEFAULT_RATING, placementGames: 0 });
  }
  return playerData.get(wallet)!;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    queueStats: matchmaking.getQueueStats(),
  });
});

// Get player rating (for frontend)
app.get('/player/:wallet', (req, res) => {
  const { wallet } = req.params;
  const data = getPlayerData(wallet);
  res.json({
    wallet,
    rating: data.rating,
    rankTier: getRankTier(data.rating),
    placementGames: data.placementGames,
    isPlacement: data.placementGames < PLACEMENT_GAMES,
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join matchmaking queue
  socket.on('join_queue', ({ wallet, queueType, equippedItems }: {
    wallet: string;
    queueType: QueueType;
    equippedItems?: any
  }) => {
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
    const match = gameManager.getMatch(matchId);
    if (!match) return;

    const playerNumber = match.player1.socketId === socket.id ? 1 : 2;
    gameManager.updatePaddle(matchId, playerNumber as 1 | 2, paddleY);
  });

  // Cancel match
  socket.on('cancel_match', ({ matchId }: { matchId: string }) => {
    gameManager.cancelMatch(matchId);
    socket.emit('match_cancelled');
  });

  // Get player rating
  socket.on('get_rating', ({ wallet }: { wallet: string }) => {
    const data = getPlayerData(wallet);
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
    matchmaking.removeFromQueue(socket.id);
    // TODO: Handle active match disconnection
  });
});

// Cleanup expired queue entries every 10 seconds
setInterval(() => {
  matchmaking.cleanupExpiredPlayers((player) => {
    io.to(player.socketId).emit('queue_timeout');
    console.log(`Player ${player.wallet} timed out from queue`);
  });
}, 10000);

// Start server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
