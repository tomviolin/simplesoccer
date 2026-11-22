import { World, Circle, Box, Settings, Polygon, Vec2Value, Contact, Body, WorldManifold } from "planck";
// vim: set ic:

import { Binder, Driver, Middleware, Runtime } from "polymatic";

import { GLDraw, initTestbedContext, TestbedMain, type TestbedContext } from "./testbed";
import soccerballUrl from "./soccerball.png";

declare global {
  interface Window {
    cueBall: BallData;
  }
}

const BLACK = "black";
const WHITE = "white";
// Paddle movement speed in world units per second.
const PADDLE_SPEED = 2.0;
// Shift-boosted paddle speed in world units per second.
const PADDLE_HIGHSPEED = 4.0;
// Initial cue ball speed in world units per second.
const CUE_SPEED = 2.0;
// A moving ball never slows below this speed, in world units per second.
const MIN_BALL_SPEED = 0.1;
// Speeds above HIGH_SPEED_LIMIT decay back toward the limit. The time constant
// controls how many seconds that takes.
const HIGH_SPEED_LIMIT = 5.0;
const HIGH_SPEED_DECAY_TAU = 0.6;
// Match length shown on the scoreboard.
const MATCH_SECONDS = 30; //1 * 60;

// Horizontal kick/spring tuning for the paddles.
// Force applied toward the table center while a kick key is held.
const KICK_FORCE = 490.0;
// Spring constant pulling a paddle back to its rest x position.
const SPRING_CONSTANT = 1000.0;
// Nominal paddle mass used to turn forces into acceleration.
const PADDLE_MASS = 1.0;
// Critical damping coefficient c = 2 * sqrt(k * m). At this value the paddle
// moves smoothly to the new equilibrium without ever oscillating.
const PADDLE_DAMPING = 2 * Math.sqrt(SPRING_CONSTANT * PADDLE_MASS);

// Maximum random angle (radians) added to a ball's rebound direction when it
// hits a rail or paddle. Rotating the velocity preserves its magnitude, so the
// bounce angle is perturbed without adding or removing kinetic energy.
const RAIL_BOUNCE_JITTER = 2.5 * (Math.PI / 180);

// Maximum per-bounce correction, in degrees, toward the 45-degree center of
// the velocity's quadrant. Raise for a stronger/faster tendency.
const REFLECTION_JITTER = 30;

// Paddle/ball friction. Paddles need grip for the contact solver to turn the
// paddle's tangential motion into spin on the ball. Other rails stay
// frictionless so they do not sap the ball's speed.
const PADDLE_FRICTION = 0.4;

// Slightly green tint for the playing-field background.
const TABLE_BACKGROUND = "#203024";

const COLORS = [
  "yellow-solid",
  //"yellow-stripe",
  "red-solid",
  //"red-stripe",
  "burgundy-solid",
  //"burgundy-stripe",
  "orange-solid",
  //"orange-stripe",
  "green-solid",
  //"green-stripe",
  "purple-solid",
  //"purple-stripe",
  "blue-solid",
  //"blue-stripe",
];
class EightBallState {
  // table geometry
  table = new BilliardTableData();
  // game data
  balls: BallData[] = [];
  rails: RailData[] = [];
  pockets: PocketData[] = [];
  // scoreboard
  score = {
    blue: 0,
    red: 0,
    elapsed: 0,
    pauseSeconds: 0,
    started: false,
    ended: false,
  };
}

interface EightBallContext extends TestbedContext {
  game: EightBallState;
}

// Visual-only soccer pitch markings. Drawn in its own GL layer, which is
// activated before the testbed's world renderer, so the lines sit under the
// rails, paddles, and balls.
class PitchLines extends Middleware<EightBallContext> {
  draw = new GLDraw();
  private segments: {
    a: { x: number; y: number };
    b: { x: number; y: number };
  }[] = [];
  private spots: { x: number; y: number }[] = [];
  private spotRadius = 0.02;
  private lastWidth = -1;
  private lastHeight = -1;

  constructor() {
    super();
    this.use(this.draw);
    this.on("frame-update", this.handleFrameUpdate);
  }

  handleFrameUpdate = () => {
    const table = this.context.game.table;
    if (
      table.tableWidth !== this.lastWidth ||
      table.tableHeight !== this.lastHeight
    ) {
      this.build(table.tableWidth, table.tableHeight);
    }

    // Exact midpoint between pure white and the field background #203024.
    const color = "#909892";
    for (const segment of this.segments) {
      // Match the fill to the stroke so the line centre renders at the full
      // midpoint colour rather than the dimmed default fill.
      this.draw.drawCapsule(segment.a, segment.b, 0, color, undefined, color);
    }
    for (const spot of this.spots) {
      this.draw.drawCircle(spot, this.spotRadius, color, undefined, color);
    }
  };

  private build(width: number, height: number) {
    this.segments.length = 0;
    this.spots.length = 0;

    const inset = Math.max(0.01, Math.min(width, height) * 0.006);
    const left = -width / 2 + inset;
    const right = width / 2 - inset;
    const bottom = -height / 2 + inset;
    const top = height / 2 - inset;
    // Standard pitch: 105 m long, 68 m wide. Scale each axis to the pitch.
    const sx = (width - inset * 2) / 105;
    const sy = (height - inset * 2) / 68;
    // Use one scale for circles and arcs so they stay round.
    const rs = (sx + sy) / 2;

    const addLine = (x1: number, y1: number, x2: number, y2: number) => {
      this.segments.push({
	a: { x: x1, y: y1 },
	b: { x: x2, y: y2 },
      });
    };
    const addArc = (
      cx: number,
      cy: number,
      rx: number,
      ry: number,
      start: number,
      end: number,
      count: number,
    ) => {
      let prevX = cx + rx * Math.cos(start);
      let prevY = cy + ry * Math.sin(start);
      for (let i = 1; i <= count; i++) {
	const angle = start + ((end - start) * i) / count;
	const x = cx + rx * Math.cos(angle);
	const y = cy + ry * Math.sin(angle);
	addLine(prevX, prevY, x, y);
	prevX = x;
	prevY = y;
      }
    };

    // Touchlines and goal lines.
    addLine(left, bottom, right, bottom);
    addLine(right, bottom, right, top);
    addLine(right, top, left, top);
    addLine(left, top, left, bottom);

    // Halfway line and centre circle.
    addLine(0, bottom, 0, top);
    addArc(0, 0, 9.15 * rs, 9.15 * rs, 0, Math.PI * 2, 64);

    // Penalty areas: 16.5 m deep, 40.32 m wide.
    const penaltyDepth = 16.5 * sx;
    const penaltyHalf = 20.16 * sy;
    addLine(left, -penaltyHalf, left + penaltyDepth, -penaltyHalf);
    addLine(left + penaltyDepth, -penaltyHalf, left + penaltyDepth, penaltyHalf);
    addLine(left + penaltyDepth, penaltyHalf, left, penaltyHalf);
    addLine(right, -penaltyHalf, right - penaltyDepth, -penaltyHalf);
    addLine(right - penaltyDepth, -penaltyHalf, right - penaltyDepth, penaltyHalf);
    addLine(right - penaltyDepth, penaltyHalf, right, penaltyHalf);

    // Penalty arcs are centred on the penalty marks, but the marks themselves
    // are not drawn.
    const leftSpotX = left + 11 * sx;
    const rightSpotX = right - 11 * sx;
    this.spots.push({ x: 0, y: 0 });

    // Penalty arcs: the part outside the penalty area.
    const arcR = 9.15 * rs;
    const theta = Math.acos(Math.min(1, (5.5 * sx) / arcR));
    addArc(leftSpotX, 0, arcR, arcR, -theta, theta, 24);
    addArc(rightSpotX, 0, arcR, arcR, Math.PI - theta, Math.PI + theta, 24);

    // Corner arcs, 3 m radius.
    const cornerRadius = 3 * rs;
    addArc(left, top, cornerRadius, cornerRadius, -Math.PI / 2, 0, 16);
    addArc(right, top, cornerRadius, cornerRadius, Math.PI, Math.PI * 1.5, 16);
    addArc(left, bottom, cornerRadius, cornerRadius, 0, Math.PI / 2, 16);
    addArc(right, bottom, cornerRadius, cornerRadius, Math.PI / 2, Math.PI, 16);

    this.spotRadius = Math.max(0.008, Math.min(width, height) * 0.006);
    this.lastWidth = width;
    this.lastHeight = height;
  }
}

// Any hrail/vrail/lgoal/rgoal/lpaddle/rpaddle file placed in the project root
// is picked up automatically at build time. Both mp3 and wav work.
const SOUND_FILES = import.meta.glob("./*.{mp3,wav,ogg}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

class SoundManager {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private urls = new Map<string, string>();

  constructor() {
    for (const [path, url] of Object.entries(SOUND_FILES)) {
      const file = path.split("/").pop() ?? path;
      const name = file.replace(/\.[^.]+$/, "");
      // Prefer mp3 when both formats are present.
      if (!this.urls.has(name) || file.toLowerCase().endsWith(".mp3")) {
        this.urls.set(name, url);
      }
    }
    for (const [name, url] of this.urls) {
      void this.load(name, url);
    }
  }

  private getContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
	.webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.context = new Ctor();
    } catch {
      return null;
    }
    this.gain = this.context.createGain();
    this.gain.gain.value = 0.5;
    this.gain.connect(this.context.destination);
    return this.context;
  }

  private async load(name: string, url: string) {
    try {
      const context = this.getContext();
      if (!context) return;
      const response = await fetch(url);
      if (!response.ok) {
	throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(data);
      this.buffers.set(name, buffer);
    } catch (error) {
      console.warn(`[sound] could not load ${name}:`, error);
    }
  }

  // Browsers require a user gesture before audio can play.
  resume() {
    if (this.urls.size === 0) return;
    const context = this.getContext();
    if (context && context.state === "suspended") {
      void context.resume();
    }
  }

  play(name: string) {
    const context = this.context;
    const buffer = this.buffers.get(name);
    if (!context || !this.gain || !buffer) return;
    if (context.state === "suspended") {
      void context.resume();
      return;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start();
  }
}

function formatClock(seconds: number) {
  const clamped = Math.max(0, seconds);
  return `${Math.floor(clamped / 60)}:${String(
    Math.floor(clamped % 60),
  ).padStart(2, "0")}`;
}

// FIFA-style scoreboard drawn in the top green rail, upper left.
class Scoreboard extends Middleware<EightBallContext> {
  constructor() {
    super();
    this.on("frame-update", this.handleFrameUpdate);
  }

  handleFrameUpdate = () => {
    const ctx = this.context.textOverlay.value;
    if (!ctx) return;

    const { game } = this.context;
    const rail =
      game.table.railThickness *
      Math.hypot(this.context.worldMatrix.a, this.context.worldMatrix.b);
    if (!(rail > 0)) return;

    const font = rail * 0.46;
    const pad = rail * 0.2;
    const barHeight = rail - pad;
    const y = (rail - barHeight) / 2;
    const x = rail + pad;
    const gap = font * 0.45;
    const chip = font * 0.7;

    const blueText = "BLUE";
    const redText = "RED";
    const scoreText = `${game.score.blue} - ${game.score.red}`;
    const clockText = formatClock(game.score.elapsed);
    const addedMinutes = Math.ceil(game.score.pauseSeconds / 60);
    const added =
      game.score.elapsed >= MATCH_SECONDS && addedMinutes > 0
        ? `+${addedMinutes}`
        : "";

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    ctx.font = `${font}px monospace`;
    const blueW = ctx.measureText(blueText).width;
    const redW = ctx.measureText(redText).width;
    const addedW = added ? ctx.measureText(added).width : 0;
    ctx.font = `bold ${font}px monospace`;
    const scoreW = ctx.measureText(scoreText).width;
    const clockW = ctx.measureText(clockText).width;

    const total =
      pad + chip + gap + blueW + gap + scoreW + gap + redW + gap + chip +
      pad + clockW + (added ? gap + addedW : 0);

    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(x, y, total, barHeight);

    const cy = y + barHeight / 2;
    const chipH = barHeight * 0.62;
    let cx = x + pad;

    ctx.fillStyle = "#8fd3ff";
    ctx.fillRect(cx, cy - chipH / 2, chip, chipH);
    cx += chip + gap;

    ctx.font = `${font}px monospace`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(blueText, cx, cy);
    cx += blueW + gap;

    ctx.font = `bold ${font}px monospace`;
    ctx.fillText(scoreText, cx, cy);
    cx += scoreW + gap;

    ctx.font = `${font}px monospace`;
    ctx.fillText(redText, cx, cy);
    cx += redW + gap;

    ctx.fillStyle = "#ffb3d1";
    ctx.fillRect(cx, cy - chipH / 2, chip, chipH);
    cx += chip + pad;

    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${font}px monospace`;
    ctx.fillText(clockText, cx, cy);

    if (added) {
      cx += clockW + gap;
      ctx.fillStyle = "#ffd75e";
      ctx.fillText(added, cx, cy);
    }

    ctx.restore();
  };
}

// Blocks the game behind a match-over panel once full time is reached.
class MatchOver extends Middleware<EightBallContext> {
  constructor() {
    super();
    this.on("frame-update", this.handleFrameUpdate);
  }

  handleFrameUpdate = () => {
    const ctx = this.context.textOverlay.value;
    if (!ctx) return;

    const ended = this.context.game.score.ended;
    ctx.canvas.style.pointerEvents = ended ? "auto" : "none";
    if (!ended) return;

    const w = ctx.canvas.clientWidth || window.innerWidth;
    const h = ctx.canvas.clientHeight || window.innerHeight;
    const boxW = Math.min(w * 0.75, 760);
    const boxH = Math.min(h * 0.32, 260);
    const bx = (w - boxW) / 2;
    const by = (h - boxH) / 2;

    ctx.save();
    // Dim the frozen match.
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.fillRect(0, 0, w, h);

    // Large match-over panel.
    ctx.fillStyle = "rgba(12, 24, 16, 0.96)";
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(2, Math.min(w, h) * 0.003);
    ctx.strokeRect(bx, by, boxW, boxH);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const titleSize = Math.min(boxW * 0.12, boxH * 0.38);
    ctx.font = `bold ${titleSize}px monospace`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText("MATCH OVER", w / 2, by + boxH * 0.4);

    const subSize = Math.max(10, titleSize * 0.36);
    ctx.font = `${subSize}px monospace`;
    ctx.fillStyle = "#d8e6d8";
    ctx.fillText("Press R to restart the game", w / 2, by + boxH * 0.72);

    ctx.restore();
  };
}

class EightBallGame extends Middleware<EightBallContext> {
  billiardPhysics = new BilliardPhysics();
  sounds = new SoundManager();
  // Track Shift keys separately so each one boosts only its own paddle.
  shiftHeld = { left: false, right: false };

  constructor() {
    super();
    this.use(this.billiardPhysics);
    this.use(new PitchLines());
    this.use(new EightBallTestbed());
    this.use(new Scoreboard());
    this.use(new MatchOver());

    this.on("activate", this.handleActivate);
    this.on("ball-in-pocket", this.onBallInPocket);
    this.on("sound", (name: string) => this.sounds.play(name));
    this.on("frame-update", this.handleClock);
    window.addEventListener("keydown", (e) => {
      // Unlock audio on the first user gesture.
      this.sounds.resume();

      // Once the match is over, only R does anything.
      if (this.context.game.score.ended) {
	e.preventDefault();
	e.stopImmediatePropagation();
	if (e.code === "KeyR") {
	  this.handleActivate();
	}
	return;
      }

      // Space toggles pause. Ignore auto-repeat so holding the key doesn't
      // flicker between paused and running.
      if (e.code === "Space") {
	e.preventDefault();
	if (!e.repeat) {
	  const score = this.context.game.score;
	  if (!score.started) {
	    // First Space: kick off the match.
	    score.started = true;
	    this.context.paused.value = false;
	    this.sounds.play("matchstart");
	  } else {
	    const resuming = this.context.paused.value;
	    this.context.paused.value = !resuming;
	    this.sounds.play(resuming ? "stoppage_end" : "stoppage_start");
	  }
	}
	return;
      }

      // Track left/right Shift separately; each boosts only its own paddle.
      if (e.code === "ShiftLeft") {
	if (!e.repeat) {
	  this.shiftHeld.left = true;
	  this.updatePaddleSpeeds();
	}
	return;
      }
      if (e.code === "ShiftRight") {
	if (!e.repeat) {
	  this.shiftHeld.right = true;
	  this.updatePaddleSpeeds();
	}
	return;
      }

      // Use e.code (physical key), not e.key, so Shift and Caps Lock don't
      // change which key we see ("W" vs "w", etc.).
      if (e.code === "KeyR") {
	this.handleActivate();
      } else if (e.code === "KeyC") {
	this.resetCueBall();
      } else if (e.code === "KeyW") {
	// paddle-0 up (ignore auto-repeat; velocity persists until keyup)
	if (!e.repeat) {
	  this.billiardPhysics.setPaddleKey(
	    "paddle-0", "up", true, this.leftPaddleSpeed(),
	  );
	}
      } else if (e.code === "KeyS") {
	// paddle-0 down
	if (!e.repeat) {
	  this.billiardPhysics.setPaddleKey(
	    "paddle-0", "down", true, this.leftPaddleSpeed(),
	  );
	}
      } else if (e.code === "KeyD") {
	// paddle-0 kick to the right
	if (!e.repeat) this.billiardPhysics.setPaddleKick("paddle-0", true);
      } else if (e.code === "ArrowLeft") {
	// paddle-1 kick to the left
	e.preventDefault();
	if (!e.repeat) this.billiardPhysics.setPaddleKick("paddle-1", true);
      } else if (e.code === "ArrowUp") {
	// paddle-1 up
	e.preventDefault();
	if (!e.repeat) {
	  this.billiardPhysics.setPaddleKey(
	    "paddle-1", "up", true, this.rightPaddleSpeed(),
	  );
	}
      } else if (e.code === "ArrowDown") {
	// paddle-1 down
	e.preventDefault();
	if (!e.repeat) {
	  this.billiardPhysics.setPaddleKey(
	    "paddle-1", "down", true, this.rightPaddleSpeed(),
	  );
	}
      }
    });

    window.addEventListener("keyup", (e) => {
      if (e.code === "ShiftLeft") {
	this.shiftHeld.left = false;
	this.updatePaddleSpeeds();
	return;
      }
      if (e.code === "ShiftRight") {
	this.shiftHeld.right = false;
	this.updatePaddleSpeeds();
	return;
      }

      if (e.code === "KeyW") {
	this.billiardPhysics.setPaddleKey(
	  "paddle-0", "up", false, this.leftPaddleSpeed(),
	);
      } else if (e.code === "KeyS") {
	this.billiardPhysics.setPaddleKey(
	  "paddle-0", "down", false, this.leftPaddleSpeed(),
	);
      } else if (e.code === "KeyD") {
	this.billiardPhysics.setPaddleKick("paddle-0", false);
      } else if (e.code === "ArrowLeft") {
	this.billiardPhysics.setPaddleKick("paddle-1", false);
      } else if (e.code === "ArrowUp") {
	this.billiardPhysics.setPaddleKey(
	  "paddle-1", "up", false, this.rightPaddleSpeed(),
	);
      } else if (e.code === "ArrowDown") {
	this.billiardPhysics.setPaddleKey(
	  "paddle-1", "down", false, this.rightPaddleSpeed(),
	);
      }
    });

    window.addEventListener("pointerdown", () => this.sounds.resume());

    // Stop any moving paddle if the window loses focus, otherwise a missed
    // keyup could leave it drifting forever.
    window.addEventListener("blur", () => {
      this.shiftHeld.left = false;
      this.shiftHeld.right = false;
      this.billiardPhysics.clearPaddleInput();
    });
  }

  leftPaddleSpeed() {
    return this.shiftHeld.left ? PADDLE_HIGHSPEED : PADDLE_SPEED;
  }

  rightPaddleSpeed() {
    return this.shiftHeld.right ? PADDLE_HIGHSPEED : PADDLE_SPEED;
  }

  updatePaddleSpeeds() {
    this.billiardPhysics.setPaddleSpeed("paddle-0", this.leftPaddleSpeed());
    this.billiardPhysics.setPaddleSpeed("paddle-1", this.rightPaddleSpeed());
  }

  // Advance the match clock. It keeps running while paused; pause time is
  // accumulated separately and shown as added time at full time.
  handleClock = (ev: { dt: number }) => {
    const score = this.context.game.score;
    if (!score.started) {
      // Kickoff: hold everything frozen until Space starts the match.
      if (!this.context.paused.value) this.context.paused.value = true;
      return;
    }
    if (score.ended) return;

    const dt = Math.min(ev.dt / 1000, 0.1);

    if (score.elapsed < MATCH_SECONDS) {
      const before = score.elapsed;
      score.elapsed = Math.min(MATCH_SECONDS, before + dt);
      if (this.context.paused.value) {
	// Pause time counts only during regulation. If this frame crosses
	// 5:00, count only the part that occurred before the whistle.
	score.pauseSeconds += score.elapsed - before;
      }
    } else {
      // During stoppage, pauses are ignored and add no further time.
      const addedMinutes = Math.ceil(score.pauseSeconds / 60);
      const end = MATCH_SECONDS + addedMinutes * 60;
      if (score.elapsed < end) {
	score.elapsed = Math.min(end, score.elapsed + dt);
      }
    }

    const addedMinutes = Math.ceil(score.pauseSeconds / 60);
    const end = MATCH_SECONDS + addedMinutes * 60;
    if (score.elapsed >= end) {
      score.elapsed = end;
      score.ended = true;
      this.sounds.play("matchend");
      // Freeze the match at full time.
      this.context.paused.value = true;
    }
  };

  // start a new game
  handleActivate() {
    console.log("Starting new game");
    const { game } = this.context;
    game.score.blue = 0;
    game.score.red = 0;
    game.score.elapsed = 0;
    game.score.pauseSeconds = 0;
    game.score.started = false;
    game.score.ended = false;
    // Kickoff: wait for Space before anything moves.
    this.context.paused.value = true;
    this.billiardPhysics.clearPaddleInput();

    const aspect = window.innerHeight > 0
      ? window.innerWidth / window.innerHeight
      : 2;
    game.table.fitToAspect(aspect);
    game.rails = game.table.getRails();
    game.pockets = game.table.getPockets();
    game.balls = game.table.rackBalls();
  }

  // reset the cue ball
  resetCueBall() {
    this.context.game.balls.push(this.context.game.table.cueBall());
  }

  // sink event listener
  onBallInPocket({ ball, pocket }: { ball: BallData; pocket: PocketData }) {
    const score = this.context.game.score;
    // Left pocket is the BLUE team's goal, so RED scores there, and vice versa.
    if (pocket.key === "pocket-1") {
      score.red += 1;
    } else if (pocket.key === "pocket-2") {
      score.blue += 1;
    }

    const index = this.context.game.balls.indexOf(ball);
    if (index !== -1) {
	    //setTimeout(() => {this.context.game.balls.splice(index, 1)},250);
	    this.context.game.balls.splice(index, 1);
	    //ball.setLinearVelocity({x:0,y:0});
    }


    if (ball.color === BLACK) {
      this.context.game.balls = [];
      setTimeout(this.handleActivate.bind(this), 400);
    } else if (ball.color === WHITE) {
      setTimeout(this.resetCueBall.bind(this), 1400);
    }
  }
}

class EightBallTestbed extends Middleware<EightBallContext> {
  constructor() {
    super();
    this.use(new TestbedMain());
    this.on("activate", this.handleActivate);
  }

  handleActivate() {
    console.log("EightBallTestbed activated");
    Settings.velocityThreshold = 0;
    this.context.style.background = TABLE_BACKGROUND;
    const table = this.context.game.table;
    this.context.camera.x = 0;
    this.context.camera.y = 0;
    // Include the rail thickness so the whole table exactly fills the window.
    this.context.camera.width = table.tableWidth + table.railThickness * 2;
    this.context.camera.height = table.tableHeight + table.railThickness * 2;
  }
}

interface BallData {
  type: "ball";
  key: string;
  position: { x: number; y: number };
  velocity?: { x: number; y: number };
  radius: number;
  color: string;
}

interface RailData {
  type: "rail";
  key: string;
  vertices: Vec2Value[] | undefined;
}

interface PocketData {
  type: "pocket";
  key: string;
  position: {
    x: number;
    y: number;
  };
  radius: number;
  thickness: number;
}

type UserData = BallData | RailData | PocketData;

const STYLES = {
  "black": { fill: "#000000", stroke: "#ffffff" },
  "white": { fill: "#ffffff", stroke: "#000000" },
  "yellow-solid": { fill: "#ffdd00", stroke: "#000000" },
//  "yellow-stripe": { fill: "#ffdd00", stroke: "#ffffff" },
  "red-solid": { fill: "#ff3300", stroke: "#000000" },
//  "red-stripe": { fill: "#ff3300", stroke: "#ffffff" },
  "burgundy-solid": { fill: "#662200", stroke: "#000000" },
//  "burgundy-stripe": { fill: "#662200", stroke: "#ffffff" },
  "orange-solid": { fill: "#ff8800", stroke: "#000000" },
//  "orange-stripe": { fill: "#ff8800", stroke: "#ffffff" },
  "green-solid": { fill: "#00bb11", stroke: "#000000" },
//  "green-stripe": { fill: "#00bb11", stroke: "#ffffff" },
  "purple-solid": { fill: "#9900ff", stroke: "#000000" },
//  "purple-stripe": { fill: "#9900ff", stroke: "#ffffff" },
  "blue-solid": { fill: "#0077ff", stroke: "#000000" },
//  "blue-stripe": { fill: "#0077ff", stroke: "#ffffff" },
} as Record<string, { fill: string; stroke: string }>;

// Table styling. Fill and stroke match so the shapes read as solid.
const MAIN_RAIL_STYLE = { fill: "#4f7d56", stroke: "#4f7d56" };
const PADDLE_STYLES = {
  "paddle-0": { fill: "#8fd3ff", stroke: "#8fd3ff" },
  "paddle-1": { fill: "#ffb3d1", stroke: "#ffb3d1" },
} as Record<string, { fill: string; stroke: string }>;
const POCKET_RAIL_STYLES = {
  // Left pocket: darker blue.
  "rail-9": { fill: "#3f6fa8", stroke: "#3f6fa8" },
  "rail-20": { fill: "#3f6fa8", stroke: "#3f6fa8" },
  "rail-21": { fill: "#3f6fa8", stroke: "#3f6fa8" },
  // Right pocket: darker pink.
  "rail-8": { fill: "#b04b7a", stroke: "#b04b7a" },
  "rail-10": { fill: "#b04b7a", stroke: "#b04b7a" },
  "rail-19": { fill: "#b04b7a", stroke: "#b04b7a" },
} as Record<string, { fill: string; stroke: string }>;
const POCKET_STYLES = {
  "pocket-1": { fill: "#ffffff", stroke: "#ffffff" },
  "pocket-2": { fill: "#ffffff", stroke: "#ffffff" },
} as Record<string, { fill: string; stroke: string }>;

class BilliardPhysics extends Middleware<EightBallContext> {
  constructor() {
    super();
    this.on("activate", this.handleActivate);
    this.on("frame-update", this.handleFrameLoop);
    // Run the horizontal spring-damper once per physics step, using the same
    // fixed timestep as the world so the motion is frame-rate independent.
    this.on("step-physics", this.handleStep);
    this.on("step-after", this.handleStepAfter);
  }

  // Tracks which direction keys are held for each paddle. `last` is the most
  // recently pressed direction, so the other key can take over immediately.
  // `kick` is true while the paddle's horizontal kick key is held.
  paddleInputs = new Map<
    string,
    {
      up: boolean;
      down: boolean;
      last: "up" | "down" | null;
      kick: boolean;
    }
  >();

  // Reused every frame to avoid allocating a new array in the hot path.
  frameData: UserData[] = [];

  // Ball/rail contacts that began this step. Their rebound direction is
  // jittered once in post-solve, after the solver has produced the new
  // velocity, so a resting contact is not perturbed on every step.
  pendingRailBounces = new WeakSet<Contact>();

  // Reused manifold for classifying a rail hit as horizontal or vertical.
  soundManifold = new WorldManifold();

  // A ball that has just been struck above the speed limit by a paddle keeps
  // that speed until it rebounds off a rail. These sets are cleared each step.
  boostedBalls = new WeakSet<Body>();
  paddleHitsThisStep = new Set<Body>();
  railHitsThisStep = new Set<Body>();


  // Keep a reference so the minimum-speed handler can look up each ball body.
  ballDriver = Driver.create<BallData, Body>({
    filter: (data) => data.type === "ball",
    enter: (data) => {
      return this.createBall(data);
    },
    update: (data, body) => {},
    exit: (data, body) => {
      this.context.world.value.destroyBody(body);
    },
  });

  // Keep a reference so we can look up a paddle's physics body by key.
  railDriver = Driver.create<RailData, Body>({
    filter: (data) => data.type === "rail",
    enter: (data) => {
      return this.createRail(data);
    },
    update: (data, body) => {
      this.updateRail(data, body);
    },
    exit: (data, body) => {
      this.context.world.value.destroyBody(body);
    },
  });

  binder = Binder.create<UserData>({
    key: (data) => data.key,
    drivers: [
      this.ballDriver,
      this.railDriver,
      Driver.create<PocketData, Body>({
        filter: (data) => data.type === "pocket",
        enter: (data) => {
          return this.createPocket(data);
        },
        update: (data, body) => {},
        exit: (data, body) => {
          this.context.world.value.destroyBody(body);
        },
      }),
    ],
  });

  handleActivate() {
    console.log("BilliardPhysics activated");
    this.context.world.value = new World({
	    gravity: {x:0,y:0.0}
    });
    this.context.world.value.on("begin-contact", this.collide);
    this.context.world.value.on("post-solve", this.handlePostSolve);
  }

  handleFrameLoop() {
    const { game } = this.context;
    const data = this.frameData;
    data.length = 0;
    for (let i = 0; i < game.balls.length; i++) data.push(game.balls[i]);
    for (let i = 0; i < game.rails.length; i++) data.push(game.rails[i]);
    for (let i = 0; i < game.pockets.length; i++) data.push(game.pockets[i]);
    this.binder.data(data);
  }

  // Update a paddle's held direction. Movement is driven by velocity, so it
  // starts immediately on keydown and continues until keyup (or the other
  // direction key is pressed).
  setPaddleKey(
    key: string,
    direction: "up" | "down",
    pressed: boolean,
    speed: number,
  ) {
    let input = this.paddleInputs.get(key);
    if (!input) {
      input = { up: false, down: false, last: null, kick: false };
      this.paddleInputs.set(key, input);
    }

    if (pressed) {
      input[direction] = true;
      input.last = direction;
    } else {
      input[direction] = false;
      if (input.last === direction) {
        // Fall back to the opposite key if it is still held, else stop.
        const other = direction === "up" ? "down" : "up";
        input.last = input[other] ? other : null;
      }
    }

    this.applyPaddleVelocity(key, speed);
  }

  // Re-apply the current direction at a new speed, e.g. when Shift is pressed
  // or released while a direction key is already held.
  setPaddleSpeed(key: string, speed: number) {
    this.applyPaddleVelocity(key, speed);
  }

  // Hold/release a paddle's horizontal kick. The force builds while the key is
  // held and disappears on release, letting the spring bring it back.
  setPaddleKick(key: string, pressed: boolean) {
    let input = this.paddleInputs.get(key);
    if (!input) {
      input = { up: false, down: false, last: null, kick: false };
      this.paddleInputs.set(key, input);
    }
    input.kick = pressed;
  }

  private applyPaddleVelocity(key: string, speed: number) {
    const input = this.paddleInputs.get(key);
    if (!input) return;

    const body = this.railDriver.ref(key);
    if (!body) return;

    const vy =
      input.last === "up" ? speed :
      input.last === "down" ? -speed : 0;
    // Keep the horizontal component: it is owned by the spring-damper.
    body.setLinearVelocity({ x: body.getLinearVelocity().x, y: vy });
  }

  // Stop all paddles (e.g. when the window loses focus and keyup may be lost).
  clearPaddleInput() {
    for (const [key, input] of this.paddleInputs) {
      input.up = false;
      input.down = false;
      input.last = null;
      input.kick = false;
      const body = this.railDriver.ref(key);
      if (body) body.setLinearVelocity({ x: 0, y: 0 });
    }
  }

  // Advance the horizontal spring-damper for both paddles. This runs before
  // each physics step so the world integrates the velocity we compute here.
  handleStep = (ev: { timeStep: number }) => {
    // Left paddle kicks right (+x), right paddle kicks left (-x).
    this.updatePaddleSpring("paddle-0", 1, ev.timeStep);
    this.updatePaddleSpring("paddle-1", -1, ev.timeStep);
  };

  // Enforce the speed limits: speeds above the high-speed limit decay back
  // toward it, and moving balls never drop below the minimum. Balls already
  // at rest stay at rest, so a freshly racked set is not set in motion.
  handleStepAfter = (ev: { timeStep: number }) => {
    const { game } = this.context;
    const dt = ev.timeStep;

    for (let i = 0; i < game.balls.length; i++) {
      const data = game.balls[i];
      const body = this.ballDriver.ref(data.key);
      if (!body) continue;

      const velocity = body.getLinearVelocity();
      const speed = Math.hypot(velocity.x, velocity.y);

      const paddleHit = this.paddleHitsThisStep.has(body);
      const railHit = this.railHitsThisStep.has(body);

      if (paddleHit && speed > HIGH_SPEED_LIMIT) {
	// A fast paddle strike is allowed to keep its speed until a rebound.
	this.boostedBalls.add(body);
      } else if (paddleHit || railHit || speed <= HIGH_SPEED_LIMIT) {
	// At or below the limit there is nothing to delay; a rail rebound also
	// ends the paddle-boost window.
	this.boostedBalls.delete(body);
      }

      // The high-speed decay only applies above the limit, and never to a
      // paddle strike that is still in flight.
      if (speed > HIGH_SPEED_LIMIT && !this.boostedBalls.has(body)) {
	const decayed =
	  HIGH_SPEED_LIMIT +
	  (speed - HIGH_SPEED_LIMIT) *
	    Math.exp(-dt / HIGH_SPEED_DECAY_TAU);
	const target =
	  decayed <= HIGH_SPEED_LIMIT + 0.01 ? HIGH_SPEED_LIMIT : decayed;
	const scale = target / speed;
	body.setLinearVelocity({
	  x: velocity.x * scale,
	  y: velocity.y * scale,
	});
      }

      // Independent of the decay: moving balls never drop below the minimum.
      if (speed > 0 && speed < MIN_BALL_SPEED) {
	const scale = MIN_BALL_SPEED / speed;
	body.setLinearVelocity({
	  x: velocity.x * scale,
	  y: velocity.y * scale,
	});
      }
    }

    this.paddleHitsThisStep.clear();
    this.railHitsThisStep.clear();
  };

  // A paddle sits at x = 0. While kicked it feels a constant force toward the
  // table center; a spring pulls it back to x = 0 and a damping force of
  // -c * vx removes energy critically, so it settles without oscillating.
  private updatePaddleSpring(key: string, kickDirection: number, dt: number) {
    const body = this.railDriver.ref(key);
    if (!body) return;

    const input = this.paddleInputs.get(key);
    const kickForce = input?.kick ? KICK_FORCE * kickDirection : 0;

    const x = body.getPosition().x;
    const velocity = body.getLinearVelocity();

    // F = kick - k*x - c*vx, and a = F/m.
    const ax =
      (kickForce - SPRING_CONSTANT * x - PADDLE_DAMPING * velocity.x) /
      PADDLE_MASS;

    body.setLinearVelocity({
      x: velocity.x + ax * dt,
      y: velocity.y,
    });
  }

  // Keep paddles inside the table. Kinematic bodies ignore collisions, so
  // clamp their position and cancel velocity when they reach a bound. The
  // horizontal axis is left alone so a kick can still play out.
  updateRail(data: RailData, body: Body) {
    if (data.key !== "paddle-0" && data.key !== "paddle-1") return;

    const table = this.context.game.table;
    const limit = table.tableHeight * 0.5 - table.railThickness;
    const position = body.getPosition();
    const velocity = body.getLinearVelocity();

    if (position.y <= -limit) {
      if (position.y < -limit) {
	body.setPosition({ x: position.x, y: -limit });
      }
      if (velocity.y < 0) {
	body.setLinearVelocity({ x: velocity.x, y: 0 });
      }
    } else if (position.y >= limit) {
      if (position.y > limit) {
	body.setPosition({ x: position.x, y: limit });
      }
      if (velocity.y > 0) {
	body.setLinearVelocity({ x: velocity.x, y: 0 });
      }
    }
  }

  createBall(data: BallData) {
    const body = this.context.world.value.createBody({
      type: "dynamic",
      bullet: true,
      position: data.position,
      linearDamping: 0,
      angularDamping: 0, //.9999,
      fixedRotation: false,
      userData: data,
    });
    if (data.velocity) {
      body.setLinearVelocity(data.velocity);
    }
    // Keep each ball's colour as a fallback, but draw the soccer-ball sprite
    // over it so its spin is visible.
    const style = { ...STYLES[data.color], sprite: soccerballUrl };
    body.createFixture({
      shape: new Circle(data.radius),
      friction: 0.45,
      restitution: 0.999,
      density: .80,
      userData: data,
      style,
    });
    return body;
  }

  createRail(data: RailData) {
    const isPaddle = data.key === "paddle-0" || data.key === "paddle-1";
    const style =
      PADDLE_STYLES[data.key] ??
      POCKET_RAIL_STYLES[data.key] ??
      MAIN_RAIL_STYLE;
    const bodyInit = {}
    if (isPaddle) {
	// kinematic: controlled by us, but still collides with the balls
	bodyInit['type'] = "kinematic";
	bodyInit['position'] = {
	  x: 0,
	  y: this.context.game.table.paddleStartY[data.key] ?? 0,
	};
    } else {
	bodyInit['type'] = "static";
    }
    bodyInit['userData'] = data;
    //const body = this.context.world.value.createBody({
    //  type: "static",
    //  userData: data,
    //});
    const body = this.context.world.value.createBody(bodyInit);
    const fixture = body.createFixture({
      shape: new Polygon(data.vertices),
      // Paddle grip lets a moving paddle spin the ball; static rails remain
      // frictionless.
      // Paddles grip the ball strongly for spin. Rails use a little friction
      // too, so they also impart angular momentum; the larger reflection
      // correction below keeps the overall angle trending toward 45 degrees.
      friction: isPaddle ? PADDLE_FRICTION : 0.02,
      restitution: 0.99,
      //density: 1.0,
      //angularDamping: 0.0,
      userData: data,
      style,
    });
    return body;
  }

  createPocket(data: PocketData) {
    const body = this.context.world.value.createBody({
      type: "static",
      position: data.position,
      userData: data,
    });
    const fixture = body.createFixture({
      shape: new Box(data.thickness, data.radius),
      userData: data,
      isSensor: true,
      style: POCKET_STYLES[data.key],
    });
    return body;
  }

  collide = (contact: Contact) => {
    const fA = contact.getFixtureA();
    const bA = fA.getBody();
    const fB = contact.getFixtureB();
    const bB = fB.getBody();

    const dataA = bA.getUserData() as UserData;
    const dataB = bB.getUserData() as UserData;

    if (!dataA || !dataB) return;

    const ball = dataA.type === "ball" ? bA : dataB.type === "ball" ? bB : null;
    const pocket = dataA.type === "pocket" ? bA : dataB.type === "pocket" ? bB : null;
    const rail = dataA.type === "rail" ? bA : dataB.type === "rail" ? bB : null;

    // Remember the rail hit so post-solve can perturb the rebound direction.
    if (ball && rail) {
      this.pendingRailBounces.add(contact);

      const railKey = (rail.getUserData() as RailData).key;
      if (railKey === "paddle-0") {
	this.paddleHitsThisStep.add(ball);
	this.emit("sound", "lpaddle");
      } else if (railKey === "paddle-1") {
	this.paddleHitsThisStep.add(ball);
	this.emit("sound", "rpaddle");
      } else {
	this.railHitsThisStep.add(ball);
	const manifold = contact.getWorldManifold(this.soundManifold);
	if (manifold && manifold.pointCount > 0) {
	  const horizontal =
	    Math.abs(manifold.normal.y) > Math.abs(manifold.normal.x);
	  this.emit("sound", horizontal ? "hrail" : "vrail");
	}
      }
    }

    if (ball && pocket) {
      const pocketData = pocket.getUserData() as PocketData;
      this.emit("sound", pocketData.key === "pocket-1" ? "lgoal" : "rgoal");
      // Remove ball from physics world immediately when it goes in pocket
      this.context.world.value.destroyBody(bA);
      this.emit("ball-in-pocket", {
        ball: ball.getUserData() as BallData,
        pocket: pocket.getUserData() as PocketData,
      });
    }
  };

  // Adjust the rebound direction of a ball leaving a rail. Every non-paddle
  // rail moves the post-reflection angle toward the 45-degree center of its
  // 90-degree quadrant; paddles keep only the small random jitter. The speed
  // is reconstructed, so the ball's kinetic energy is preserved.
  handlePostSolve = (contact: Contact) => {
    if (!this.pendingRailBounces.has(contact)) return;
    this.pendingRailBounces.delete(contact);

    const dataA = contact.getFixtureA().getBody().getUserData() as UserData;
    const dataB = contact.getFixtureB().getBody().getUserData() as UserData;

    const ball =
      dataA?.type === "ball" ? contact.getFixtureA().getBody() :
      dataB?.type === "ball" ? contact.getFixtureB().getBody() : null;
    if (!ball) return;

    const railData =
      dataA?.type === "rail" ? dataA :
      dataB?.type === "rail" ? dataB : null;

    const velocity = ball.getLinearVelocity();
    let vx = velocity.x;
    let vy = velocity.y;

    const isPaddle =
      railData?.key === "paddle-0" || railData?.key === "paddle-1";

    if (railData && !isPaddle) {
      // Work from the post-reflection angle A, in degrees, and move it toward
      // the 45-degree center of its 90-degree quadrant.
      const speed = Math.hypot(vx, vy);
      if (speed > 0) {
	const A = Math.atan2(vy, vx) * 180 / Math.PI;
	const At = Math.floor(A / 90) * 90;
	const At45 = At + 45;
	const dA = At45 - A;
	const correction = (dA / 45) * Math.random() * REFLECTION_JITTER;

	const adjusted = (A + correction) * Math.PI / 180;
	vx = speed * Math.cos(adjusted);
	vy = speed * Math.sin(adjusted);
      }
    } else {
      // Paddles keep the small random angle jitter.
      const angle = (Math.random() * 2 - 1.2) * RAIL_BOUNCE_JITTER;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const oldVx = vx;
      const oldVy = vy;
      vx = oldVx * cos - oldVy * sin;
      vy = oldVx * sin + oldVy * cos;
    }

    ball.setLinearVelocity({ x: vx, y: vy });
  };
}

// table data
class BilliardTableData {
  tableWidth = 8.0;
  tableHeight = 4.0;

  // Height at which pocket dimensions are defined. Pockets scale with the
  // current table height so they keep the same fraction of the sides.
  readonly referenceTableHeight = this.tableHeight;

  ballRadius = 0.12;
  pocketRadius = 0.80;
  pocketDepth = 0.16;
  pocketSpaceBehind = 0.20;
  // Half-width of the pocket sensor. Kept as thin as reliably possible so it
  // behaves like a line at the pocket mouth.
  pocketSensorThickness = 0.001;
  railThickness = 0.2;

  // Long outer dimension of the pitch in world units. The camera maps this
  // dimension onto max(window width, window height), so every object's screen
  // size scales with the larger screen dimension. Lower this value to make
  // objects larger; raise it to make them smaller.
  pitchLongSide = 7.0;

  // Match the outer table bounds to the window aspect ratio while keeping the
  // pitch's long side fixed. Both table dimensions adapt; the camera then uses
  // one uniform scale.
  fitToAspect(aspect: number) {
    const longSide = this.pitchLongSide;
    const outerWidth = aspect >= 1 ? longSide : longSide * aspect;
    const outerHeight = aspect >= 1 ? longSide / aspect : longSide;
    const minInterior = this.ballRadius * 4;
    this.tableWidth = Math.max(outerWidth - this.railThickness * 2, minInterior);
    this.tableHeight = Math.max(outerHeight - this.railThickness * 2, minInterior);
  }

  // Playfield objects (balls, paddles, pockets) scale with the current table
  // height, so their proportions relative to the vertical sides stay fixed.
  get contentScale() {
    return this.tableHeight / this.referenceTableHeight;
  }

  // Starting y positions of the player-controlled paddles.
  paddleStartY: Record<string, number> = {
    "paddle-0": -0.4,
    "paddle-1": 0.0,
  };

  // Clearance between the paddle's back face and the pocket's innermost rail,
  // at the reference table height. Scales with the pockets so the paddle never
  // touches the pocket.
  paddleTrackClearance = 0.08;

  // A paddle is a vertical slab with a flat back and a convex face toward the
  // table center. The exposed face is a semi-ellipse: its thickness tapers to
  // `endThickness` at the ends and reaches twice that in the middle. The
  // polygon is convex and wound counter-clockwise, as planck requires.
  paddleVertices(
    backX: number,
    facing: 1 | -1,
    yBottom: number,
    yTop: number,
    endThickness: number,
  ): Vec2Value[] {
    const segments = 8;
    const midY = (yBottom + yTop) * 0.5;
    const halfHeight = (yTop - yBottom) * 0.5;

    // Sample the semi-elliptical bulge from bottom to top. Using the ellipse's
    // angle parameter clusters points near the ends, where it changes fastest.
    const inner: Vec2Value[] = [];
    for (let i = 0; i <= segments; i++) {
      const theta = -Math.PI / 2 + (Math.PI * i) / segments;
      const bulge = Math.cos(theta); // 0 at the ends, 1 in the middle
      inner.push({
	y: midY + halfHeight * Math.sin(theta),
	x: backX + facing * endThickness * (1 + bulge),
      });
    }

    const backBottom = { x: backX, y: yBottom };
    const backTop = { x: backX, y: yTop };

    if (facing > 0) {
      // Left paddle: bottom edge runs right, then the bulge is walked upward.
      return [backBottom, ...inner, backTop];
    }

    // Right paddle: mirror image, walked in reverse so the winding stays CCW.
    return [inner[0], backBottom, backTop, ...inner.slice(1).reverse()];
  }

  getRails(): RailData[] {
    const halfWidth = this.tableWidth * 0.5;
    const halfHeight = this.tableHeight * 0.5;
    const thickness = this.railThickness;
    const contentScale = this.contentScale;
    const mouth = this.pocketRadius * contentScale;
    const pocketDepth = this.pocketDepth * contentScale;
    const pocketSpaceBehind = this.pocketSpaceBehind * contentScale;
    // Paddles scale with the pockets.
    const paddleHalfHeight = mouth / 4;
    // Place the track just inside the pocket's innermost rail. The rail
    // thickness is unscaled, while the pocket depth/space-behind are scaled,
    // so derive this from the actual rail boundary rather than scaling the
    // whole inset.
    const pocketInnerX = halfWidth - thickness - pocketSpaceBehind - pocketDepth * 2;
    const paddleX = pocketInnerX - this.paddleTrackClearance * contentScale;
    // axis-aligned rectangle with counter-clockwise winding
    const rectangle = (x1: number, y1: number, x2: number, y2: number) => [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
    ];

    return [
      {
	type: "rail",
	key: "paddle-0",
	// Shape is defined around the body origin; the body's y position is what
	// actually moves (see movePaddle). Do not bake the paddle offset in here.
	// Flat back on the left, convex face toward the table center on the right.
	vertices: this.paddleVertices(
	  -paddleX,
	  1,
	  -paddleHalfHeight,
	  paddleHalfHeight,
	  thickness * contentScale / 2,
	),
      },
      {
	type: "rail",
	key: "paddle-1",
	// Flat back on the right, convex face toward the table center on the left.
	vertices: this.paddleVertices(
	  paddleX,
	  -1,
	  -paddleHalfHeight,
	  paddleHalfHeight,
	  thickness * contentScale / 2,
	),
      },
      {
        type: "rail",
        key: "rail-1",
        // top cushion, closed at both corners
        vertices: rectangle(
          -halfWidth - thickness,
          halfHeight,
          halfWidth + thickness,
          halfHeight + thickness,
        ),
      },
      {
        type: "rail",
        key: "rail-2",
        // bottom cushion, closed at both corners
        vertices: rectangle(
          -halfWidth - thickness,
          -halfHeight - thickness,
          halfWidth + thickness,
          -halfHeight,
        ),
      },
      {
        type: "rail",
        key: "rail-3",
        // right cushion, above the side pocket
        vertices: rectangle(
          halfWidth,
          -halfHeight-thickness,
          halfWidth + thickness,
          halfHeight + thickness,
        ),
      },
     /* {
        type: "rail",
        key: "rail-4",
        // right cushion, below the side pocket
        vertices: rectangle(
          halfWidth,
          -halfHeight - thickness,
          halfWidth + thickness,
          -mouth,
        ),
      }, */
      {
        type: "rail",
        key: "rail-5",
        // left cushion, above the side pocket
        vertices: rectangle(
          -halfWidth - thickness,
          -halfHeight - thickness,
          -halfWidth,
          halfHeight + thickness,
        ),
      },
      /*{
        type: "rail",
        key: "rail-6",
        // left cushion, below the side pocket
        vertices: rectangle(
          -halfWidth - thickness,
          -halfHeight - thickness,
          -halfWidth,
          -mouth,
        ),
      },
      {
	type: "rail",
	key: "rail-7",
	// right cushion, below the side pocket
	vertices: rectangle(
	  halfWidth,
	  mouth,
	  halfWidth + thickness,
	  halfHeight + thickness,
	),
      }, */
      {
	type: "rail",
	key: "rail-8",
	// back of pocket, right side
	// very thin rectangle to prevent goals from behind the net
	vertices: rectangle(
	  halfWidth-pocketSpaceBehind,
	  -mouth-thickness/5,
	  halfWidth -pocketSpaceBehind+ thickness/5,
	  mouth+thickness/5,
	),
      },
      {
	type: "rail",
	key: "rail-10",
	// top of pocket, right side
	// very thin rectangle to prevent goals from above the net
	// this is a bit of a hack, but it works
	vertices: rectangle(
	  halfWidth-pocketSpaceBehind-pocketDepth*2-thickness,
	 -mouth-thickness/5,
	  halfWidth -pocketSpaceBehind+ thickness/5, 
	 -mouth),
      },
      {
	type: "rail",
	key: "rail-19",
	// bot of pocket, right side
	// very thin rectangle to prevent goals from above the net
	// this is a bit of a hack, but it works
	vertices: rectangle(
	  halfWidth-pocketSpaceBehind-pocketDepth*2-thickness,
	 mouth+thickness/5,
	  halfWidth -pocketSpaceBehind+ thickness/5, 
	 mouth),
      },
      {
	type: "rail",
	key: "rail-9",
	// back of pocket, left side
	// very thin rectangle to prevent goals from behind the net
	vertices: rectangle(
	  -halfWidth+pocketSpaceBehind-thickness/5,
	  -mouth-thickness/5,
	  -halfWidth +pocketSpaceBehind,//+thickness/5,
	  mouth+thickness/5,
	),
      },
      {
	type: "rail",
	key: "rail-20",
	// top of pocket, left side
	// very thin rectangle to prevent goals from above the net
	// this is a bit of a hack, but it works
	vertices: rectangle(
	 -halfWidth+pocketSpaceBehind,
	 -mouth-thickness/5,
	 -halfWidth +pocketSpaceBehind+pocketDepth*2+thickness, 
	 -mouth),
      },
      {
	type: "rail",
	key: "rail-21",
	// bot of pocket, left side
	// very thin rectangle to prevent goals from above the net
	// this is a bit of a hack, but it works
	vertices: rectangle(
	 -halfWidth+pocketSpaceBehind,
	 mouth,
	 -halfWidth +pocketSpaceBehind+pocketDepth*2+thickness, 
	 mouth+thickness/5)
      },
    ];
  }

  getPockets(): PocketData[] {
    const contentScale = this.contentScale;
    const radius = this.pocketRadius * contentScale;
    // A tiny positive width still generates contacts (planck's polygon radius
    // supplies the effective skin), so keep it near zero rather than clamping
    // to the linear slop.
    const thickness = Math.max(this.pocketSensorThickness * contentScale, 1e-6);
    const behind = this.pocketSpaceBehind * contentScale;

    return [
      {
        type: "pocket",
        key: "pocket-1",
        radius,
        thickness,
        position: {
          // square sensor: shift out by half its side so its inner edge
          // sits flush with the cushion's inner wall
          x: -this.tableWidth * 0.5 + this.railThickness + behind,
          y: 0,
        },
      },
      {
        type: "pocket",
        key: "pocket-2",
        radius,
        thickness,
        position: {
          x: +this.tableWidth * 0.5 - this.railThickness - behind,
          y: 0,
        },
      },
    ];
  }

  rackBalls() {
    const r = this.ballRadius * this.contentScale;
    const cx = this.tableWidth / 4;
    const cy = 0;

    const SPI3 = Math.sin(Math.PI / 3);

    Util.shuffleArray(COLORS);

    const n = 5;
    const balls: BallData[] = [];
    const d = r * 2;
    const l = SPI3 * d;
    
    if (false){
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        balls.push({
          type: "ball",
          key: "ball-" + Math.random(),
          position: {
            x: cx + i * l /*- (n - 1) * 0.5 * l*/ + Math.random() * r * 0.02,
            y: cy + (j - i * 0.5) * d + Math.random() * r * 0.02,
          },
          radius: r,
          color: COLORS[balls.length],
        });
      }
    }

    balls[14].color = balls[4].color;
    balls[4].color = BLACK;
    }
    window.cueBall = this.cueBall();
    balls.push(window.cueBall);

    return balls;
  }

  cueBall(): BallData {
    // Random direction within 45° above/below horizontal, with left and right
    // equally likely.
    const angle = (Math.random() - 0.5) * (Math.PI / 2); // -45°..45°
    const horizontal = Math.random() < 0.5 ? -1 : 1;
    const radius = this.ballRadius * this.contentScale;

    return {
      type: "ball",
      key: "ball-" + Math.random(),
      position: {
        // Table center == screen center (the camera is centered on 0, 0).
        x: 0,
        y: 0,
      },
      velocity: {
        x: horizontal * CUE_SPEED * Math.cos(angle),
        y: CUE_SPEED * Math.sin(angle),
      },
      radius,
      color: WHITE,
    };
  }
}

class Util {
  static shuffleArray<T>(array: T[]) {
    // http://stackoverflow.com/a/12646864/483728
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
    return array;
  }
}

const main = new EightBallGame();
const context = initTestbedContext({ game: new EightBallState() });
Runtime.activate(main, context);
main.emit("tool-switch", { name: "interact-impulse", mouseForce: -20 });
main.emit("game-start");
