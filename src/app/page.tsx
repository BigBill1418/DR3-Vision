import Image from 'next/image';

// T-001 placeholder — third iteration. The canonical DR3-Vision logo
// arrived (Bill, 2026-05-06; HANDOFF open decision #1 + ADR-0012 §5
// close together): an eye-as-"o" treatment in cyan on a dark space
// backdrop, executed at production quality. This page is the only
// surface that runs on a black background; the global theme stays
// on --dr3-green-deep per ADR-0008.
//
// Caption under the SVdP seal links out to svdp.us at Bill's request.
export default function Page() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-black px-6 text-center">
      <div className="flex flex-col items-center gap-8">
        <Image
          src="/brand/dr3-vision-logo.jpg"
          alt="DR3-Vision"
          width={1168}
          height={784}
          priority
          className="h-auto w-full max-w-3xl"
        />
        <p className="text-lg font-medium text-dr3-chartreuse sm:text-xl">— coming soon</p>
      </div>

      <a
        href="https://svdp.us"
        className="absolute inset-x-0 bottom-8 mx-auto flex flex-col items-center gap-2 text-white/70 transition-colors hover:text-white"
        aria-label="St. Vincent de Paul Society of Lane County — svdp.us"
      >
        <Image src="/brand/svdp-logo-seal.png" alt="" width={72} height={72} priority />
        <span className="text-sm underline-offset-4 hover:underline">svdp.us</span>
      </a>
    </main>
  );
}
