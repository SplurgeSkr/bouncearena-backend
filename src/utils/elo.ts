import { RANK_TIERS, PLACEMENT_GAMES } from '../game/types';

// K-Factor determines how much ratings change per game
const K_FACTOR_STANDARD = 32;
const K_FACTOR_PLACEMENT = 64; // Higher during placement for faster calibration

/**
 * Calculate the expected score for a player based on ratings
 * @param playerRating - The player's current rating
 * @param opponentRating - The opponent's current rating
 * @returns Expected score between 0 and 1
 */
export function calculateExpectedScore(playerRating: number, opponentRating: number): number {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
}

/**
 * Calculate rating changes after a match
 * @param winnerRating - Winner's rating before match
 * @param loserRating - Loser's rating before match
 * @param winnerPlacementGames - Number of placement games winner has played
 * @param loserPlacementGames - Number of placement games loser has played
 * @returns Object containing rating changes for winner and loser
 */
export function calculateEloChange(
  winnerRating: number,
  loserRating: number,
  winnerPlacementGames: number = PLACEMENT_GAMES,
  loserPlacementGames: number = PLACEMENT_GAMES
): { winnerChange: number; loserChange: number } {
  // Determine K-factors based on placement status
  const winnerK = winnerPlacementGames < PLACEMENT_GAMES ? K_FACTOR_PLACEMENT : K_FACTOR_STANDARD;
  const loserK = loserPlacementGames < PLACEMENT_GAMES ? K_FACTOR_PLACEMENT : K_FACTOR_STANDARD;

  // Calculate expected scores
  const winnerExpected = calculateExpectedScore(winnerRating, loserRating);
  const loserExpected = calculateExpectedScore(loserRating, winnerRating);

  // Calculate rating changes
  // Winner: actual score is 1, loser: actual score is 0
  const winnerChange = Math.round(winnerK * (1 - winnerExpected));
  const loserChange = Math.round(loserK * (0 - loserExpected));

  // Ensure minimum change of 1 for winner and -1 for loser
  return {
    winnerChange: Math.max(winnerChange, 1),
    loserChange: Math.min(loserChange, -1),
  };
}

/**
 * Get the rank tier for a given rating
 * @param rating - Player's rating
 * @returns Rank tier name
 */
export function getRankTier(rating: number): string {
  for (const tier of RANK_TIERS) {
    if (rating >= tier.minRating && rating <= tier.maxRating) {
      return tier.name;
    }
  }
  return 'Bronze'; // Fallback
}

/**
 * Get the color for a given rating
 * @param rating - Player's rating
 * @returns Hex color string
 */
export function getRankColor(rating: number): string {
  for (const tier of RANK_TIERS) {
    if (rating >= tier.minRating && rating <= tier.maxRating) {
      return tier.color;
    }
  }
  return '#CD7F32'; // Bronze fallback
}

/**
 * Calculate new rating after a match result
 * @param currentRating - Player's current rating
 * @param opponentRating - Opponent's rating
 * @param won - Whether the player won
 * @param placementGames - Number of placement games played
 * @returns New rating
 */
export function calculateNewRating(
  currentRating: number,
  opponentRating: number,
  won: boolean,
  placementGames: number = PLACEMENT_GAMES
): number {
  const kFactor = placementGames < PLACEMENT_GAMES ? K_FACTOR_PLACEMENT : K_FACTOR_STANDARD;
  const expected = calculateExpectedScore(currentRating, opponentRating);
  const actual = won ? 1 : 0;
  const change = Math.round(kFactor * (actual - expected));

  // Ensure rating doesn't go below 0
  return Math.max(0, currentRating + change);
}

/**
 * Get division within a tier (I, II, III, IV)
 * @param rating - Player's rating
 * @returns Division string (e.g., "Gold II")
 */
export function getRankWithDivision(rating: number): string {
  const tier = getRankTier(rating);
  const tierData = RANK_TIERS.find(t => t.name === tier);

  if (!tierData || tier === 'Master') {
    return tier; // Master doesn't have divisions
  }

  const tierRange = tierData.maxRating - tierData.minRating + 1;
  const divisionSize = tierRange / 4;
  const positionInTier = rating - tierData.minRating;

  if (positionInTier < divisionSize) return `${tier} IV`;
  if (positionInTier < divisionSize * 2) return `${tier} III`;
  if (positionInTier < divisionSize * 3) return `${tier} II`;
  return `${tier} I`;
}
