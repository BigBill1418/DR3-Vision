import Image from 'next/image';

// T-001 placeholder, second iteration. Per ADR-0012 §5 the placeholder
// originally shipped as a pure text wordmark. This iteration replaces the
// "o" in "Vision" with an inline-SVG eyeball glyph (sclera in --dr3-cream,
// iris in --dr3-green, pupil in --dr3-ink, with a small cream catchlight
// for life). On trial as a candidate canonical-logo direction; if it
// holds up it gets promoted into `public/brand/dr3-logo.svg` and ADR-0012
// §5 closes alongside HANDOFF open decision #1.
//
// The St. Vincent de Paul seal at the bottom is the parent-org credit
// (DR3 is a wholly owned subsidiary of SVdP Lane County). Per ADR-0008
// the SVdP red palette belongs to the parent, not to DR3 itself, so it
// lives small + footer-attributed and never bleeds into the DR3 surface.
export default function Page() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-6xl font-bold tracking-tight sm:text-7xl">
        <span>DR</span>
        <span className="text-dr3-green">3</span>
        <span>-Visi</span>
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label="o"
          className="inline-block h-[0.62em] w-[0.62em] -translate-y-[0.04em] align-baseline"
        >
          <circle cx="50" cy="50" r="48" fill="#FCFFD7" />
          <circle cx="50" cy="50" r="28" fill="#49AD8E" />
          <circle cx="50" cy="50" r="11" fill="#1A1A1A" />
          <circle cx="42" cy="42" r="4" fill="#FCFFD7" />
        </svg>
        <span>n</span>
      </h1>
      <p className="mt-6 text-lg font-medium text-dr3-chartreuse sm:text-xl">— coming soon</p>

      <footer className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-2">
        <Image
          src="/brand/svdp-logo-seal.png"
          alt="St. Vincent de Paul Society of Lane County"
          width={72}
          height={72}
          priority
        />
        <p className="text-xs text-dr3-cream/70">
          A St. Vincent de Paul Society of Lane County initiative
        </p>
      </footer>
    </main>
  );
}
