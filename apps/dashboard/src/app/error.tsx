"use client";

import { useEffect } from "react";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto max-w-md rounded-lg border border-border bg-surface px-5 py-8 text-center">
      <h2 className="font-semibold">Something went wrong</h2>
      <p className="mt-1 text-sm text-muted">
        {error.digest ? `Reference: ${error.digest}` : "Please try again."}
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white"
      >
        Try again
      </button>
    </div>
  );
}
