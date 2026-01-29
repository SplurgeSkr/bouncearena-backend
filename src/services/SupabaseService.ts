import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://urxputozzwjdxuwvbblk.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

let supabase: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!SUPABASE_KEY) {
    console.warn('SUPABASE_KEY not set - database features disabled');
    return null;
  }
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabase;
}

export interface PlayerData {
  rating: number;
  placementGames: number;
}

export interface LeaderboardEntry {
  user_wallet: string;
  rating: number;
  wins: number;
  losses: number;
  current_streak: number;
  best_streak: number;
  updated_at: string;
}

/**
 * Fetch player rating from Supabase leaderboard table.
 * Returns null if not found or DB unavailable.
 */
export async function getPlayerRating(wallet: string): Promise<PlayerData | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('leaderboard')
      .select('rating, wins, losses')
      .eq('user_wallet', wallet)
      .single();

    if (error || !data) return null;

    // Estimate placement games from total games played (capped at 10)
    const totalGames = (data.wins || 0) + (data.losses || 0);
    return {
      rating: data.rating || 1000,
      placementGames: Math.min(totalGames, 10),
    };
  } catch (e) {
    console.error('Failed to fetch player rating:', e);
    return null;
  }
}

/**
 * Update player stats after a ranked match.
 */
export async function updatePlayerAfterMatch(
  wallet: string,
  newRating: number,
  won: boolean,
  currentStreak: number,
  bestStreak: number
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    // Fetch existing to merge
    const { data: existing } = await client
      .from('leaderboard')
      .select('*')
      .eq('user_wallet', wallet)
      .single();

    const newStreak = won ? (existing?.current_streak || 0) + 1 : 0;
    const newBestStreak = Math.max(newStreak, existing?.best_streak || 0);

    const entry = {
      user_wallet: wallet,
      rating: newRating,
      wins: (existing?.wins || 0) + (won ? 1 : 0),
      losses: (existing?.losses || 0) + (won ? 0 : 1),
      current_streak: newStreak,
      best_streak: newBestStreak,
      updated_at: new Date().toISOString(),
    };

    const { error } = await client
      .from('leaderboard')
      .upsert(entry, { onConflict: 'user_wallet' });

    if (error) {
      console.error('Failed to update leaderboard:', error);
    } else {
      console.log(`Leaderboard updated for ${wallet}: rating=${newRating}, won=${won}`);
    }
  } catch (e) {
    console.error('Failed to update player after match:', e);
  }
}

/**
 * Record a completed match in match_history table.
 */
export async function recordMatch(
  matchId: string,
  player1Wallet: string,
  player2Wallet: string,
  winnerWallet: string,
  player1Score: number,
  player2Score: number,
  queueType: string,
  player1RatingChange: number,
  player2RatingChange: number
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client
      .from('match_history')
      .insert({
        match_id: matchId,
        player1_wallet: player1Wallet,
        player2_wallet: player2Wallet,
        winner_wallet: winnerWallet,
        player1_score: player1Score,
        player2_score: player2Score,
        queue_type: queueType,
        player1_rating_change: player1RatingChange,
        player2_rating_change: player2RatingChange,
      });

    if (error) {
      console.error('Failed to record match:', error);
    } else {
      console.log(`Match ${matchId} recorded in history`);
    }
  } catch (e) {
    console.error('Failed to record match:', e);
  }
}

/**
 * Fetch all purchased item IDs for a given wallet.
 */
export async function getPlayerPurchases(wallet: string): Promise<string[]> {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('purchases')
      .select('item_id')
      .eq('buyer_wallet', wallet)
      .eq('verified', true);

    if (error || !data) return [];
    return data.map((row: any) => row.item_id);
  } catch (e) {
    console.error('Failed to fetch player purchases:', e);
    return [];
  }
}

/**
 * Save equipped items for a wallet.
 */
export async function saveEquippedItems(
  wallet: string,
  equippedItems: { paddle: string; ball: string; trail: string; court: string }
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client
      .from('equipped_items')
      .upsert({
        user_wallet: wallet,
        paddle: equippedItems.paddle,
        ball: equippedItems.ball,
        trail: equippedItems.trail,
        court: equippedItems.court,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_wallet' });

    if (error) {
      console.error('Failed to save equipped items:', error);
    }
  } catch (e) {
    console.error('Failed to save equipped items:', e);
  }
}

/**
 * Fetch equipped items for a wallet.
 */
export async function getEquippedItems(
  wallet: string
): Promise<{ paddle: string; ball: string; trail: string; court: string } | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from('equipped_items')
      .select('paddle, ball, trail, court')
      .eq('user_wallet', wallet)
      .single();

    if (error || !data) return null;
    return data as { paddle: string; ball: string; trail: string; court: string };
  } catch (e) {
    console.error('Failed to fetch equipped items:', e);
    return null;
  }
}

/**
 * Record a purchase in purchases table.
 */
export async function recordPurchase(
  buyerWallet: string,
  itemId: string,
  txSignature: string,
  amountSol: number,
  verified: boolean
): Promise<void> {
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client
      .from('purchases')
      .insert({
        buyer_wallet: buyerWallet,
        item_id: itemId,
        tx_signature: txSignature,
        amount_sol: amountSol,
        verified,
      });

    if (error) {
      console.error('Failed to record purchase:', error);
    }
  } catch (e) {
    console.error('Failed to record purchase:', e);
  }
}
