/**
 * Apple-style water-droplet ripple driven by Pixi.js DisplacementFilter.
 *
 * Lifecycle:
 *  1. Snapshot the live DOM to an HTMLCanvasElement via `html-to-image`.
 *  2. Mount a full-viewport Pixi canvas overlay showing that snapshot.
 *  3. Apply a DisplacementFilter to the snapshot sprite. The displacement
 *     map is a generated 512×512 image whose RG channels encode an
 *     outward-pointing radial vector field modulated by a decaying
 *     sin wave — i.e. multiple concentric crest+trough rings emanating
 *     from the map's center, identical to a real droplet's wave packet.
 *  4. Place the displacement sprite at the impact point and grow it
 *     from zero to ~1.5× viewport diameter over the animation, so the
 *     rings appear to propagate outward. Filter intensity ramps in
 *     fast, sustains briefly, then decays — matches how real surface
 *     waves lose energy with distance.
 *  5. Remove the canvas + destroy the Pixi app on completion.
 *
 * Restraint choices (Apple-like polish):
 *   • Subtle amplitude — max displacement scale 24 px (not 60).
 *   • Decelerating ease (cubic-bezier(0.16, 1, 0.3, 1)) — Apple's
 *     standard "settle into rest" curve.
 *   • Fade-out tail rather than abrupt stop.
 *   • No screen shake during the displacement — the rippling itself
 *     conveys impact more elegantly.
 *
 * Heavy deps (pixi.js + html-to-image, ~550 KB) are dynamically
 * imported so the welcome-screen initial bundle pays nothing until
 * the easter egg first fires.
 */

let inFlight = false
let warmed: Promise<readonly [typeof import('pixi.js'), typeof import('html-to-image')]> | null = null

/**
 * Pre-fetch + parse the heavy bundles in the background so the slam
 * impact moment doesn't stall the main thread parsing ~2 MB of JS.
 * Idempotent — caches the promise so concurrent calls share the work.
 */
export function warmWaterSlam(): Promise<readonly [typeof import('pixi.js'), typeof import('html-to-image')]> {
  if (!warmed) {
    warmed = Promise.all([import('pixi.js'), import('html-to-image')] as const)
  }
  return warmed
}

interface RippleParams {
  /** Spacing between ring crests in the displacement map (px). */
  wavelength: number
  /** Phase offset (radians) so initial ring positions vary run-to-run. */
  phase: number
}

function buildRippleDisplacementMap({ wavelength, phase }: RippleParams): HTMLCanvasElement {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) return canvas

  const img = ctx.createImageData(size, size)
  const data = img.data
  const cx = size / 2
  const cy = size / 2
  // Beyond this radius the wave is fully decayed and the map encodes
  // "no displacement" (128, 128).
  const decay = size / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx
      const dy = y - cy
      const r = Math.sqrt(dx * dx + dy * dy)
      const off = (y * size + x) * 4

      if (r >= decay) {
        data[off] = 128
        data[off + 1] = 128
        data[off + 2] = 0
        data[off + 3] = 255
        continue
      }

      // Radial sin wave with smooth Hann-style amplitude envelope so
      // the rings fade gracefully toward the edge of the map (no hard
      // boundary that would read as a circle).
      const tNorm = r / decay
      const envelope = 0.5 * (1 + Math.cos(tNorm * Math.PI)) // 1 at center → 0 at decay
      const wave = Math.sin((r / wavelength) * Math.PI * 2 + phase)
      const amplitude = envelope * wave

      const nx = r === 0 ? 0 : dx / r
      const ny = r === 0 ? 0 : dy / r

      // 128 = neutral, ±127 = full displacement. Scale by 110 so we
      // leave a small range for filter.scale to amplify without hitting
      // the clipping ceiling.
      data[off]     = Math.max(0, Math.min(255, 128 + nx * amplitude * 110))
      data[off + 1] = Math.max(0, Math.min(255, 128 + ny * amplitude * 110))
      data[off + 2] = 0
      data[off + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

/**
 * Pre-capture the welcome screen at rest so triggerWaterSlam can start
 * the displacement at the moment of impact without waiting on a fresh
 * html-to-image pass. Call once on welcome-screen mount.
 */
export async function prepareSlamSnapshot(): Promise<HTMLCanvasElement | null> {
  try {
    const [, htmlToImage] = await warmWaterSlam()
    return await htmlToImage.toCanvas(document.body, {
      cacheBust: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
    })
  } catch (err) {
    console.error('[water-slam] pre-capture failed:', err)
    return null
  }
}

export async function triggerWaterSlam(
  impactX: number,
  impactY: number,
  preCapturedSnapshot?: HTMLCanvasElement | null
): Promise<void> {
  if (inFlight) return
  inFlight = true

  let appRef: { destroy: (opts?: unknown) => void } | null = null
  let canvasEl: HTMLCanvasElement | null = null

  try {
    const [pixi, htmlToImage] = await warmWaterSlam()
    const { Application, Sprite, Texture, DisplacementFilter } = pixi

    const w = window.innerWidth
    const h = window.innerHeight

    // Per-fire randomization so back-to-back triggers don't read as
    // the same animation. Independent ranges chosen so the effect
    // still feels coherent — wider/tighter rings, stronger/weaker
    // refraction, slower/quicker dissipation. Amplitude pushed wider
    // (30-55) so the wave is unambiguously visible.
    // Duration and radius are sized so even the slowest reflected ring
    // (second-order, from a corner mirror) finishes crossing the
    // viewport before the cut. Otherwise waves get yanked mid-flight
    // and read as a jump-cut rather than the system settling.
    //   • radiusFactor ≥ ~1.75 lets corner-mirror rings reach the
    //     far diagonal corner for a centered impact (≈1.5×diagonal).
    //     Bumped to 2.5–3.5 to comfortably cover off-center impacts.
    //   • duration grown proportionally so the rings still feel like
    //     they're moving at a believable surface-wave speed.
    const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
    const wavelength    = rand(20, 34)
    const phase         = rand(0, Math.PI * 2)
    const duration      = rand(3500, 4800)
    const maxAmplitude  = rand(30, 55)
    const radiusFactor  = rand(2.5, 3.5)
    const maxRingRadius = Math.max(w, h) * radiusFactor

    // Use the snapshot pre-captured on welcome-screen mount if it's
    // ready; otherwise capture now (slightly delays the ripple). The
    // snapshot is of the welcome screen at rest, which is pixel-
    // identical to the live DOM at the moment of impact, so the swap
    // from live → Pixi is invisible.
    const snapshot = preCapturedSnapshot ?? await htmlToImage.toCanvas(document.body, {
      cacheBust: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
    })
    const app = new Application()
    await app.init({
      width: w,
      height: h,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true
    })
    appRef = app as unknown as { destroy: (opts?: unknown) => void }

    canvasEl = app.canvas as HTMLCanvasElement
    canvasEl.style.position = 'fixed'
    canvasEl.style.left = '0'
    canvasEl.style.top = '0'
    canvasEl.style.width = '100vw'
    canvasEl.style.height = '100vh'
    canvasEl.style.pointerEvents = 'none'
    canvasEl.style.zIndex = '9999'
    document.body.appendChild(canvasEl)

    const bgTex = Texture.from(snapshot)
    const bgSprite = new Sprite(bgTex)
    bgSprite.width = w
    bgSprite.height = h
    app.stage.addChild(bgSprite)

    // Method-of-images reflections: each window edge acts like a rigid
    // wall, so we place virtual wave sources at the impact point
    // mirrored across each wall. Their rings expand in sync with the
    // primary — by the time the primary hits a wall, the virtual ring
    // has reached the same wall from outside, and the portion inside
    // the viewport reads as a reflected wave traveling back inward.
    //
    // Two wave SYSTEMS are stacked: one for the logo's first ground
    // contact and a second, weaker one for the bounce-back contact.
    // Each system has its own first-order reflections (4 mirrors).
    // The primary system also gets second-order (corner) reflections.
    // Wave 2 starts later in the global timeline and uses a smaller
    // ring radius so the second bounce reads as gentler than the first.
    interface Source {
      x: number
      y: number
      amp: number
      /** Proportional start time within the global animation (0-1). */
      startT: number
      /** Per-source max ring radius (smaller for the weaker second bounce). */
      ringRadius: number
    }
    const wave1Radius = maxRingRadius
    const wave2Radius = maxRingRadius * 0.7
    const wave1Start = 0.00
    const wave2Start = 0.30
    const sources: Source[] = [
      // ---- Wave 1: first ground impact ----
      // Primary
      { x: impactX,         y: impactY,         amp: 1.00, startT: wave1Start, ringRadius: wave1Radius },
      // First-order (one bounce off each wall)
      { x: -impactX,        y: impactY,         amp: 0.55, startT: wave1Start, ringRadius: wave1Radius },
      { x: 2 * w - impactX, y: impactY,         amp: 0.55, startT: wave1Start, ringRadius: wave1Radius },
      { x: impactX,         y: -impactY,        amp: 0.55, startT: wave1Start, ringRadius: wave1Radius },
      { x: impactX,         y: 2 * h - impactY, amp: 0.55, startT: wave1Start, ringRadius: wave1Radius },
      // Second-order (two-bounce, corner mirrors)
      { x: -impactX,        y: -impactY,        amp: 0.28, startT: wave1Start, ringRadius: wave1Radius },
      { x: 2 * w - impactX, y: -impactY,        amp: 0.28, startT: wave1Start, ringRadius: wave1Radius },
      { x: -impactX,        y: 2 * h - impactY, amp: 0.28, startT: wave1Start, ringRadius: wave1Radius },
      { x: 2 * w - impactX, y: 2 * h - impactY, amp: 0.28, startT: wave1Start, ringRadius: wave1Radius },
      // ---- Wave 2: bounce-back impact (gentler, no corner reflections) ----
      { x: impactX,         y: impactY,         amp: 0.50, startT: wave2Start, ringRadius: wave2Radius },
      { x: -impactX,        y: impactY,         amp: 0.28, startT: wave2Start, ringRadius: wave2Radius },
      { x: 2 * w - impactX, y: impactY,         amp: 0.28, startT: wave2Start, ringRadius: wave2Radius },
      { x: impactX,         y: -impactY,        amp: 0.28, startT: wave2Start, ringRadius: wave2Radius },
      { x: impactX,         y: 2 * h - impactY, amp: 0.28, startT: wave2Start, ringRadius: wave2Radius }
    ]

    const dispTex = Texture.from(buildRippleDisplacementMap({ wavelength, phase }))
    const dispSprites: import('pixi.js').Sprite[] = []
    const filters: import('pixi.js').DisplacementFilter[] = []
    for (const src of sources) {
      const ds = new Sprite(dispTex)
      ds.anchor.set(0.5)
      ds.x = src.x
      ds.y = src.y
      ds.width = 8
      ds.height = 8
      // The filter only needs the sprite's texture + transform; the
      // sprite itself shouldn't paint on top of the snapshot.
      ds.renderable = false
      app.stage.addChild(ds)
      dispSprites.push(ds)
      filters.push(new DisplacementFilter({ sprite: ds, scale: 0 }))
    }
    bgSprite.filters = filters

    const startTime = performance.now()

    // cubic-bezier(0.16, 1, 0.3, 1) — Apple's "standard decelerate".
    const easeOut = (t: number): number => {
      const c = t - 1
      return 1 + c * c * c
    }

    // Intensity envelope: smooth rise, brief hold at full strength,
    // then a smooth decay to zero by the time the animation ends. At
    // t=1 the displacement is exactly 0 — so when we remove the
    // canvas, the snapshot is already pixel-identical to the live
    // DOM behind it. No visible jump, no fade tail; the wave just
    // dissipates naturally and the swap is invisible.
    const smoothstep = (e0: number, e1: number, x: number): number => {
      const u = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
      return u * u * (3 - 2 * u)
    }
    const envelope = (t: number): number => {
      const rise = smoothstep(0, 0.12, t)
      const decay = 1 - smoothstep(0.45, 1.0, t)
      return rise * decay
    }

    return await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - startTime
        const t = elapsed / duration

        if (t >= 1) {
          bgSprite.filters = []
          if (canvasEl && canvasEl.parentNode) {
            canvasEl.parentNode.removeChild(canvasEl)
          }
          app.destroy({ removeView: true } as never)
          appRef = null
          canvasEl = null
          inFlight = false
          resolve()
          return
        }

        // Each source has its own local timeline so the two wave
        // systems (first bounce, second bounce) start at different
        // moments. Sources within the same system stay in lockstep
        // because they share startT — that synchrony is what lets
        // their reflected rings appear to emerge from the walls.
        for (let i = 0; i < sources.length; i++) {
          const src = sources[i]
          if (t < src.startT) {
            filters[i].scale.x = 0
            filters[i].scale.y = 0
            continue
          }
          const localT = (t - src.startT) / (1 - src.startT)
          const radius = easeOut(localT) * src.ringRadius
          dispSprites[i].width = radius * 2
          dispSprites[i].height = radius * 2
          const env = envelope(localT)
          const intensity = maxAmplitude * src.amp * env
          filters[i].scale.x = intensity
          filters[i].scale.y = intensity
        }

        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  } catch (err) {
    // Failure modes: html-to-image refusing a tainted canvas (rare on
    // local-only images), Pixi failing to init on this GPU. Either way,
    // bail cleanly so the easter egg doesn't crash the renderer.
    console.error('Water slam ripple failed:', err)
    try { appRef?.destroy({ removeView: true } as never) } catch { /* noop */ }
    if (canvasEl && canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl)
    inFlight = false
  }
}
