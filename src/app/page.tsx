// Placeholder landing for T-001. Per ADR-0012 §5 the brand mark is the text
// wordmark "DR3-Vision" on `--dr3-green-deep` with the "3" tinted `--dr3-green`
// in Inter. The canonical logo SVG slots into `public/brand/dr3-logo.svg` via
// a single-file swap once Bill provides it (HANDOFF open decision #1).
export default function Page() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-6xl font-bold tracking-tight sm:text-7xl">
        <span>DR</span>
        <span className="text-dr3-green">3</span>
        <span>-Vision</span>
      </h1>
      <p className="mt-6 text-lg font-medium text-dr3-chartreuse sm:text-xl">— coming soon</p>
    </main>
  );
}
