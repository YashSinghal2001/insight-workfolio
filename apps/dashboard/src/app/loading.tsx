export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="mx-auto flex max-w-5xl animate-pulse flex-col gap-6">
      <div className="h-8 w-40 rounded bg-border" />
      <div className="h-12 rounded-lg bg-border" />
      <div className="h-48 rounded-lg bg-border" />
    </div>
  );
}
