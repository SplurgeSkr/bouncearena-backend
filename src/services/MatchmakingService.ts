import { QueuedPlayer, QueueType } from '../game/types';

const MATCH_TIMEOUT = 60000; // 60 seconds
const RATING_RANGE_INITIAL = 100; // Initial rating range for matching
const RATING_RANGE_MAX = 500; // Maximum rating range after waiting
const RATING_EXPAND_INTERVAL = 10000; // Expand range every 10 seconds

export class MatchmakingService {
  private rankedQueue: QueuedPlayer[] = [];
  private unrankedQueue: QueuedPlayer[] = [];

  /**
   * Add a player to the appropriate queue
   * @param player - The player to add
   * @returns Matched opponent if found, null if added to queue
   */
  addToQueue(player: QueuedPlayer): QueuedPlayer | null {
    if (player.queueType === 'ranked') {
      return this.addToRankedQueue(player);
    } else {
      return this.addToUnrankedQueue(player);
    }
  }

  /**
   * Add player to ranked queue with rating-based matching
   */
  private addToRankedQueue(player: QueuedPlayer): QueuedPlayer | null {
    // Try to find an opponent within rating range
    const opponent = this.findRankedOpponent(player);

    if (opponent) {
      // Remove opponent from queue
      const index = this.rankedQueue.indexOf(opponent);
      if (index !== -1) {
        this.rankedQueue.splice(index, 1);
      }
      return opponent;
    }

    // No match found, add to queue
    this.rankedQueue.push(player);
    return null;
  }

  /**
   * Find a suitable opponent for ranked matching
   * Considers rating range that expands over time
   */
  private findRankedOpponent(player: QueuedPlayer): QueuedPlayer | null {
    if (this.rankedQueue.length === 0) return null;

    // Calculate expanded rating range based on wait time
    const waitTime = Date.now() - player.queuedAt;
    const expandedRange = Math.min(
      RATING_RANGE_INITIAL + Math.floor(waitTime / RATING_EXPAND_INTERVAL) * 50,
      RATING_RANGE_MAX
    );

    // Find the closest rated opponent within range
    let bestMatch: QueuedPlayer | null = null;
    let bestDiff = Infinity;

    for (const opponent of this.rankedQueue) {
      // Don't match with self (same wallet)
      if (opponent.wallet === player.wallet) continue;

      const ratingDiff = Math.abs(opponent.rating - player.rating);

      // Check if opponent is within our range
      if (ratingDiff <= expandedRange) {
        // Also check opponent's expanded range
        const opponentWaitTime = Date.now() - opponent.queuedAt;
        const opponentRange = Math.min(
          RATING_RANGE_INITIAL + Math.floor(opponentWaitTime / RATING_EXPAND_INTERVAL) * 50,
          RATING_RANGE_MAX
        );

        if (ratingDiff <= opponentRange && ratingDiff < bestDiff) {
          bestMatch = opponent;
          bestDiff = ratingDiff;
        }
      }
    }

    return bestMatch;
  }

  /**
   * Add player to unranked queue with random matching
   */
  private addToUnrankedQueue(player: QueuedPlayer): QueuedPlayer | null {
    // For unranked, match with anyone available
    if (this.unrankedQueue.length > 0) {
      // Find first opponent that isn't the same player
      const index = this.unrankedQueue.findIndex(p => p.wallet !== player.wallet);
      if (index !== -1) {
        const opponent = this.unrankedQueue[index];
        this.unrankedQueue.splice(index, 1);
        return opponent;
      }
    }

    // No match found, add to queue
    this.unrankedQueue.push(player);
    return null;
  }

  /**
   * Remove a player from all queues
   */
  removeFromQueue(socketId: string): boolean {
    // Check ranked queue
    const rankedIndex = this.rankedQueue.findIndex(p => p.socketId === socketId);
    if (rankedIndex !== -1) {
      this.rankedQueue.splice(rankedIndex, 1);
      return true;
    }

    // Check unranked queue
    const unrankedIndex = this.unrankedQueue.findIndex(p => p.socketId === socketId);
    if (unrankedIndex !== -1) {
      this.unrankedQueue.splice(unrankedIndex, 1);
      return true;
    }

    return false;
  }

  /**
   * Clean up players who have been waiting too long
   */
  cleanupExpiredPlayers(onTimeout: (player: QueuedPlayer) => void): void {
    const now = Date.now();

    // Clean ranked queue
    this.rankedQueue = this.rankedQueue.filter(player => {
      if (now - player.queuedAt > MATCH_TIMEOUT) {
        onTimeout(player);
        return false;
      }
      return true;
    });

    // Clean unranked queue
    this.unrankedQueue = this.unrankedQueue.filter(player => {
      if (now - player.queuedAt > MATCH_TIMEOUT) {
        onTimeout(player);
        return false;
      }
      return true;
    });
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): { queueType: QueueType; players: number; avgRating?: number }[] {
    const rankedAvg = this.rankedQueue.length > 0
      ? Math.round(this.rankedQueue.reduce((sum, p) => sum + p.rating, 0) / this.rankedQueue.length)
      : undefined;

    return [
      { queueType: 'ranked', players: this.rankedQueue.length, avgRating: rankedAvg },
      { queueType: 'unranked', players: this.unrankedQueue.length },
    ];
  }

  /**
   * Get estimated wait time for a player based on queue state
   */
  getEstimatedWaitTime(queueType: QueueType, rating: number): number {
    if (queueType === 'unranked') {
      // Unranked: just check if anyone is waiting
      return this.unrankedQueue.length > 0 ? 0 : 15000; // 0 or ~15 seconds
    }

    // Ranked: check for players within initial range
    const playersInRange = this.rankedQueue.filter(
      p => Math.abs(p.rating - rating) <= RATING_RANGE_INITIAL
    );

    if (playersInRange.length > 0) return 0;

    // Check for players within expanded range
    const playersInExpandedRange = this.rankedQueue.filter(
      p => Math.abs(p.rating - rating) <= RATING_RANGE_MAX
    );

    if (playersInExpandedRange.length > 0) {
      // Estimate based on how long until ranges overlap
      return 20000; // ~20 seconds
    }

    // No good matches, estimate longer wait
    return 45000; // ~45 seconds
  }
}
