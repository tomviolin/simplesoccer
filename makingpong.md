# Making Pong — 8-Ball Paddle Controls & Performance Work

Export of the OpenCode session working in `/home/tomh/fractional_engineering/8ball`.

---

## Objective

Turn the 8-ball table's side rails into player-controlled paddles:

- **Left paddle** (`paddle-0`) moves with `w` / `s`.
- **Right paddle** (`paddle-1`) moves with `ArrowUp` / `ArrowDown`.
- Movement must be **velocity-based and continuous** — start on keydown, continue until keyup, switch direction immediately when the opposite key is pressed.
- New cue balls spawn at the **table center `(0, 0)`** with a random direction and a fixed speed of **2.0 units/sec**.
- Later: **Shift-boosted** paddle speeds.
- Later: mitigate **GC pauses** in the frame loop.

---

## 1. Velocity-based paddle movement

### Design

- The planck `Body` is the **single source of truth** for paddle position. The old `window.paddle0` / `window.paddle1` globals were removed.
- Paddles are **kinematic** bodies: they stay where driven but still collide with balls.
- Shape vertices are fixed; only the body's `y` position moves (no baked-in offset).
- Movement applies `body.setLinearVelocity({ x: 0, y: ±PADDLE_SPEED })`.
- Bounds are enforced in the rail driver's `update` callback by clamping the body position and zeroing outward velocity, so no hidden accumulated offset can build up.

### Input state

Each paddle tracks its held directions and the most recently pressed one:

```ts
paddleInputs = new Map<
  string,
  { up: boolean; down: boolean; last: "up" | "down" | null }
>();
```

- `last` is the most recently pressed direction, so the opposite key takes over instantly.
- Releasing `last` falls back to the other key if it is still held, otherwise stops.
- Auto-repeat `keydown` events are ignored via `!e.repeat`.
- `blur` clears all paddle input so a missed `keyup` cannot leave a paddle drifting.

### Velocity application

```ts
setPaddleKey(
  key: string,
  direction: "up" | "down",
  pressed: boolean,
  speed: number,
) {
  let input = this.paddleInputs.get(key);
  if (!input) {
    input = { up: false, down: false, last: null };
    this.paddleInputs.set(key, input);
  }

  if (pressed) {
    input[direction] = true;
    input.last = direction;
  } else {
    input[direction] = false;
    if (input.last === direction) {
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

private applyPaddleVelocity(key: string, speed: number) {
  const input = this.paddleInputs.get(key);
  if (!input) return;

  const body = this.railDriver.ref(key);
  if (!body) return;

  const vy =
    input.last === "up" ? speed :
    input.last === "down" ? -speed : 0;
  body.setLinearVelocity({ x: 0, y: vy });
}
```

`BilliardPhysics.railDriver.ref(key)` returns the persistent `Body` for `paddle-0` / `paddle-1`.

---

## 2. Cue ball spawn

New cue balls now appear at the table center with a random shallow angle:

```ts
// Initial cue ball speed in world units per second.
const CUE_SPEED = 2.0;
```

- Position: `(0, 0)`.
- Speed: exactly `2.0` units/sec.
- Direction: random within ±45° of horizontal, left/right equally likely.
- Implemented by adding an optional `BallData.velocity` applied in `createBall` via `body.setLinearVelocity`.

Verified over 200k samples: speed exactly 2.0, angle within −45°..45°, left ≈ 50.1%.

---

## 3. Shift-boosted paddle speed

### Problem

Pressing Shift (or having Caps Lock on) changed the character reported by `e.key` (`"w"` → `"W"`), breaking paddle movement.

### Fix: physical key codes

All key handling switched from `e.key` to **`e.code`**, which is unaffected by Shift and Caps Lock:

```ts
if (e.code === "KeyR") ...
else if (e.code === "KeyC") ...
else if (e.code === "KeyW") ...
else if (e.code === "KeyS") ...
else if (e.code === "ArrowUp") ...
else if (e.code === "ArrowDown") ...
```

### Boost

```ts
// Paddle movement speed in world units per second.
const PADDLE_SPEED = 2.0;
// Shift-boosted paddle speed in world units per second.
const PADDLE_HIGHSPEED = 4.0;
```

Left and right Shift are tracked **separately**, so each boosts only its own paddle:

```ts
// Track Shift keys separately so each one boosts only its own paddle.
shiftHeld = { left: false, right: false };

leftPaddleSpeed()  { return this.shiftHeld.left  ? PADDLE_HIGHSPEED : PADDLE_SPEED; }
rightPaddleSpeed() { return this.shiftHeld.right ? PADDLE_HIGHSPEED : PADDLE_SPEED; }

updatePaddleSpeeds() {
  this.billiardPhysics.setPaddleSpeed("paddle-0", this.leftPaddleSpeed());
  this.billiardPhysics.setPaddleSpeed("paddle-1", this.rightPaddleSpeed());
}
```

`ShiftLeft` / `ShiftRight` keydown and keyup update `shiftHeld` and call `updatePaddleSpeeds()`, so the change takes effect **mid-movement**.

| Keys | Result |
|------|--------|
| `w` / `s` | left paddle at 2.0 units/sec |
| `LeftShift` + `w` / `s` | left paddle at 4.0 units/sec |
| `↑` / `↓` | right paddle at 2.0 units/sec |
| `RightShift` + `↑` / `↓` | right paddle at 4.0 units/sec |

`blur` clears both Shift flags before stopping the paddles.

Verified with a state-machine simulation: normal → 2.0, Shift → 4.0, Shift release → 2.0, key release → 0; left Shift does not boost the right paddle and vice versa; Shift-before-key behaves the same as key-before-Shift.

---

## 4. GC pauses

### Question

> There are somewhat frequent pauses in the action likely due to garbage collection. Can this be mitigated by manually triggering garbage collection periodically?

### Answer

No. Browsers expose no standard GC API (`window.gc()` only exists in Chrome with `--expose-gc`, or Firefox with a debug pref). Forcing collection just schedules more of the same pauses. The real fix is **reducing per-frame allocations**.

### Sources found

In `vendor/planck/dist/testbed.mjs`:

1. `uploadPolygonVertexTexture()` allocated a new `Float32Array(width * height * 2)` every frame.
2. `uploadAndDraw()` allocated `new Float32Array(data)` on every draw call.
3. `DrawWorld.drawBody()` allocated, per fixture per frame: a `styles` array, two `.find(...)` closures, and a `shape.m_vertices.slice(...)` array.

In `8ball.ts`:

4. `handleFrameLoop()` built `[...game.balls, ...game.rails, ...game.pockets]` every frame.

At 60 fps this was roughly 600 KB/sec of short-lived garbage for a tiny scene.

### Fix in the game loop

```ts
// Reused every frame to avoid allocating a new array in the hot path.
frameData: UserData[] = [];

handleFrameLoop() {
  const { game } = this.context;
  const data = this.frameData;
  data.length = 0;
  for (let i = 0; i < game.balls.length; i++) data.push(game.balls[i]);
  for (let i = 0; i < game.rails.length; i++) data.push(game.rails[i]);
  for (let i = 0; i < game.pockets.length; i++) data.push(game.pockets[i]);
  this.binder.data(data);
}
```

### Fixes in the testbed renderer

- Reused grow-only polygon-vertex buffer (`polygonRowData`).
- Reused grow-only per-draw upload buffer (`uploadArray`).
- Allocation-free `DrawWorld.drawBody` (direct style lookups + reused `polygonPoints` array instead of `slice()`).

Result: noticeably more playable, with far fewer minor-GC pauses.

---

## 5. Local testbed fork

The testbed is separate from the planck physics engine. To keep the vendored package pristine, the optimized testbed was moved into the project root.

### File layout

- **`testbed.mjs`** (new) — local fork containing the three allocation reductions, with a header comment documenting the fork.
- **`testbed.d.ts`** (new) — matching type declarations.
- **`8ball.ts`** — import changed:
  ```ts
  import { initTestbedContext, TestbedMain, type TestbedContext } from "./testbed";
  ```
- **`vendor/planck/dist/testbed.mjs`** — restored to the original by reversing all four edits.

A `diff` between the vendor file and the local copy shows exactly the intended enhancements, only in the local copy.

---

## Verification

- `npx tsc --noEmit` passes.
- `npm run build` passes; production bundle includes the local enhanced testbed.
- Paddle behavior verified with a state-machine simulation (direction switching, fallback, Shift boost, Shift-before-key).
- Cue direction distribution verified over 200k samples.
- No per-frame allocation patterns remain in the game hot path (`[...game.*]`, `new Float32Array(data)`, `styles = [`).

---

## Maintenance notes

- The local `testbed.mjs` is a fork of `vendor/planck/dist/testbed.mjs`. Updating the vendored planck/testbed will **not** update the local fork; re-copy and reapply the three allocation fixes if needed.
- The project is **not** a git repository; all changes are plain file edits.
- Key files: `8ball.ts`, `testbed.mjs`, `testbed.d.ts`, `vendor/planck/dist/planck.mjs`, `package.json`.
