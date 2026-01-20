import { Match, GameState, QueueType, EquippedItems } from './types';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 450; // 16:9 aspect ratio
const BALL_SIZE = 12;
const PADDLE_WIDTH = 10;
const PADDLE_HEIGHT = 80;
const PADDLE_OFFSET = 30;
const BALL_SPEED_INITIAL = 3;
const BALL_SPEED_MAX = 12;
const BALL_SPEED_INCREASE = 0.3;
const SCORE_TO_WIN = 11;

export class GameManager {
  private matches: Map<string, Match> = new Map();
  private gameLoops: Map<string, NodeJS.Timeout> = new Map();
  private previousStates: Map<string, GameState> = new Map();

  createMatch(
    matchId: string,
    player1SocketId: string,
    player1Wallet: string,
    player1Rating: number,
    queueType: QueueType,
    equippedItems?: EquippedItems
  ): Match {
    const match: Match = {
      id: matchId,
      player1: {
        socketId: player1SocketId,
        wallet: player1Wallet,
        rating: player1Rating,
        equippedItems,
      },
      player2: null,
      queueType,
      gameState: this.initializeGameState(),
      createdAt: Date.now(),
      status: 'waiting',
      winner: null,
    };

    this.matches.set(matchId, match);
    return match;
  }

  joinMatch(
    matchId: string,
    player2SocketId: string,
    player2Wallet: string,
    player2Rating: number,
    equippedItems?: EquippedItems
  ): Match | null {
    const match = this.matches.get(matchId);
    if (!match || match.player2 || match.status !== 'waiting') {
      return null;
    }

    match.player2 = {
      socketId: player2SocketId,
      wallet: player2Wallet,
      rating: player2Rating,
      equippedItems,
    };
    match.status = 'active';

    return match;
  }

  startGameLoop(matchId: string, onUpdate: (gameState: Partial<GameState>) => void, onEnd: (winner: string) => void): void {
    const interval = setInterval(() => {
      const match = this.matches.get(matchId);
      if (!match || match.status !== 'active') {
        this.stopGameLoop(matchId);
        return;
      }

      // Update game state
      this.updateGameState(match);

      // Check for winner
      if (match.gameState.player1Score >= SCORE_TO_WIN) {
        match.winner = match.player1.wallet;
        match.status = 'completed';
        this.stopGameLoop(matchId);
        onEnd(match.player1.wallet);
        return;
      } else if (match.gameState.player2Score >= SCORE_TO_WIN) {
        match.winner = match.player2!.wallet;
        match.status = 'completed';
        this.stopGameLoop(matchId);
        onEnd(match.player2!.wallet);
        return;
      }

      // Send delta update (only changed properties)
      const deltaState = this.createDeltaState(matchId, match.gameState);
      onUpdate(deltaState);

      // Store current state as previous for next delta
      this.previousStates.set(matchId, { ...match.gameState });
    }, 1000 / 60); // 60 FPS server tick rate for smoother gameplay

    this.gameLoops.set(matchId, interval);
  }

  stopGameLoop(matchId: string): void {
    const interval = this.gameLoops.get(matchId);
    if (interval) {
      clearInterval(interval);
      this.gameLoops.delete(matchId);
      this.previousStates.delete(matchId);
    }
  }

  // Create delta state - only include properties that changed
  private createDeltaState(matchId: string, currentState: GameState): Partial<GameState> {
    const previousState = this.previousStates.get(matchId);

    // First update - send full state
    if (!previousState) {
      return currentState as Partial<GameState>;
    }

    // Create delta with only changed properties
    const delta: Partial<GameState> = {};

    // Round to 2 decimal places to reduce false positives from floating point errors
    const round = (n: number) => Math.round(n * 100) / 100;

    if (round(currentState.ballX) !== round(previousState.ballX)) delta.ballX = currentState.ballX;
    if (round(currentState.ballY) !== round(previousState.ballY)) delta.ballY = currentState.ballY;
    if (round(currentState.ballVelX) !== round(previousState.ballVelX)) delta.ballVelX = currentState.ballVelX;
    if (round(currentState.ballVelY) !== round(previousState.ballVelY)) delta.ballVelY = currentState.ballVelY;
    if (round(currentState.ballSpeed) !== round(previousState.ballSpeed)) delta.ballSpeed = currentState.ballSpeed;
    if (round(currentState.player1PaddleY) !== round(previousState.player1PaddleY)) delta.player1PaddleY = currentState.player1PaddleY;
    if (round(currentState.player2PaddleY) !== round(previousState.player2PaddleY)) delta.player2PaddleY = currentState.player2PaddleY;
    if (currentState.player1Score !== previousState.player1Score) delta.player1Score = currentState.player1Score;
    if (currentState.player2Score !== previousState.player2Score) delta.player2Score = currentState.player2Score;
    if (currentState.gameStarted !== previousState.gameStarted) delta.gameStarted = currentState.gameStarted;
    if (currentState.countdown !== previousState.countdown) delta.countdown = currentState.countdown;
    if (currentState.isCountingDown !== previousState.isCountingDown) delta.isCountingDown = currentState.isCountingDown;

    return delta;
  }

  updatePaddle(matchId: string, player: 1 | 2, paddleY: number): void {
    const match = this.matches.get(matchId);
    if (!match) return;

    if (player === 1) {
      match.gameState.player1PaddleY = Math.max(
        0,
        Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, paddleY)
      );
    } else {
      match.gameState.player2PaddleY = Math.max(
        0,
        Math.min(CANVAS_HEIGHT - PADDLE_HEIGHT, paddleY)
      );
    }
  }

  cancelMatch(matchId: string): void {
    const match = this.matches.get(matchId);
    if (match) {
      match.status = 'cancelled';
      this.stopGameLoop(matchId);
      this.matches.delete(matchId);
    }
  }

  getMatch(matchId: string): Match | undefined {
    return this.matches.get(matchId);
  }

  private initializeGameState(): GameState {
    const angle = (Math.random() - 0.5) * (Math.PI / 4);
    const speed = BALL_SPEED_INITIAL;

    return {
      ballX: CANVAS_WIDTH / 2,
      ballY: CANVAS_HEIGHT / 2,
      ballVelX: Math.cos(angle) * speed * (Math.random() > 0.5 ? 1 : -1),
      ballVelY: Math.sin(angle) * speed,
      ballSpeed: BALL_SPEED_INITIAL,
      player1PaddleY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
      player2PaddleY: CANVAS_HEIGHT / 2 - PADDLE_HEIGHT / 2,
      player1Score: 0,
      player2Score: 0,
      gameStarted: false,  // Start with countdown
      countdown: 3,        // 3 second countdown
      isCountingDown: true,
    };
  }

  private updateGameState(match: Match): void {
    const state = match.gameState;

    // Handle countdown (decrement every 60 ticks = ~1 second)
    if (state.isCountingDown && !state.gameStarted) {
      if (!match.countdownTicks) match.countdownTicks = 0;
      match.countdownTicks++;

      if (match.countdownTicks >= 60) {
        match.countdownTicks = 0;
        state.countdown--;

        if (state.countdown <= 0) {
          state.gameStarted = true;
          state.isCountingDown = false;
        }
      }
      return; // Don't update ball/physics during countdown
    }

    if (!state.gameStarted) return;

    // Update ball position
    state.ballX += state.ballVelX;
    state.ballY += state.ballVelY;

    // Wall collisions (top/bottom)
    if (state.ballY < 0 || state.ballY + BALL_SIZE > CANVAS_HEIGHT) {
      state.ballVelY = -state.ballVelY;
      state.ballY = state.ballY < 0 ? 0 : CANVAS_HEIGHT - BALL_SIZE;
    }

    // Paddle collision - Player 1 (left) with improved detection
    // Check if ball is moving towards paddle and in collision zone
    if (
      state.ballVelX < 0 && // Ball moving left
      state.ballX <= PADDLE_OFFSET + PADDLE_WIDTH &&
      state.ballX + BALL_SIZE >= PADDLE_OFFSET && // Extended collision zone
      state.ballY + BALL_SIZE >= state.player1PaddleY &&
      state.ballY <= state.player1PaddleY + PADDLE_HEIGHT
    ) {
      const hitPos = (state.ballY + BALL_SIZE / 2 - state.player1PaddleY) / PADDLE_HEIGHT;
      const angle = (hitPos - 0.5) * (Math.PI / 3);

      state.ballSpeed = Math.min(state.ballSpeed + BALL_SPEED_INCREASE, BALL_SPEED_MAX);
      state.ballVelX = Math.abs(Math.cos(angle) * state.ballSpeed); // Ensure positive (moving right)
      state.ballVelY = Math.sin(angle) * state.ballSpeed;
      state.ballX = PADDLE_OFFSET + PADDLE_WIDTH; // Push ball out of paddle
    }

    // Paddle collision - Player 2 (right) with improved detection
    // Check if ball is moving towards paddle and in collision zone
    if (
      state.ballVelX > 0 && // Ball moving right
      state.ballX + BALL_SIZE >= CANVAS_WIDTH - PADDLE_OFFSET - PADDLE_WIDTH &&
      state.ballX <= CANVAS_WIDTH - PADDLE_OFFSET && // Extended collision zone
      state.ballY + BALL_SIZE >= state.player2PaddleY &&
      state.ballY <= state.player2PaddleY + PADDLE_HEIGHT
    ) {
      const hitPos = (state.ballY + BALL_SIZE / 2 - state.player2PaddleY) / PADDLE_HEIGHT;
      const angle = (hitPos - 0.5) * (Math.PI / 3);

      state.ballSpeed = Math.min(state.ballSpeed + BALL_SPEED_INCREASE, BALL_SPEED_MAX);
      state.ballVelX = -Math.abs(Math.cos(angle) * state.ballSpeed); // Ensure negative (moving left)
      state.ballVelY = Math.sin(angle) * state.ballSpeed;
      state.ballX = CANVAS_WIDTH - PADDLE_OFFSET - PADDLE_WIDTH - BALL_SIZE; // Push ball out of paddle
    }

    // Scoring
    if (state.ballX < 0) {
      // Player 2 scores
      state.player2Score += 1;
      this.resetBall(state, true);
    } else if (state.ballX > CANVAS_WIDTH) {
      // Player 1 scores
      state.player1Score += 1;
      this.resetBall(state, false);
    }
  }

  private resetBall(state: GameState, serveToPlayer1: boolean): void {
    const angle = (Math.random() - 0.5) * (Math.PI / 4);
    const speed = BALL_SPEED_INITIAL;

    state.ballX = CANVAS_WIDTH / 2;
    state.ballY = CANVAS_HEIGHT / 2;
    state.ballVelX = Math.cos(angle) * speed * (serveToPlayer1 ? -1 : 1);
    state.ballVelY = Math.sin(angle) * speed;
    state.ballSpeed = BALL_SPEED_INITIAL;

    // Start countdown
    state.gameStarted = false;
    state.isCountingDown = true;
    state.countdown = 3;
  }

  private handleCountdown(state: GameState): void {
    if (state.isCountingDown && state.countdown > 0) {
      // Countdown is handled by decrementing every ~1 second (60 ticks)
      // This is approximate and will be refined client-side
    }
  }
}
 
