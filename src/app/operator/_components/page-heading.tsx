// ADR-0065 — one heading shape for every operator screen.
//
// The 9 operator pages carried three incompatible header markups (a
// title+caption flex row with a sign-out button, a stacked back-link + title,
// and a bare title), so the same screen furniture landed at a different height
// and alignment on each. Now that back + Log Out live in FloorChrome, the page
// header is only ever a title and an optional caption — so it is one component.
//
// Deliberately NOT a client component: every operator page is a server
// component and resolves its strings server-side via `translate()`.

export function FloorPageHeading({ title, caption }: { title: string; caption?: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {caption && <p className="text-sm opacity-70">{caption}</p>}
    </header>
  );
}
