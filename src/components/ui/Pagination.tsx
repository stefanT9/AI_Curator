import Link from "next/link";
import { secondaryButtonClass } from "@/components/ui/Field";

type PaginationProps = {
  page: number;
  totalPages: number;
  /** The route's own path, e.g. "/studio" or "/auctions" — no query string. */
  basePath: string;
};

/**
 * Previous/Next controls for a paginated grid. At each boundary the disabled
 * side renders as a plain `span`, not a link with `pointer-events` suppressed
 * — so it is actually inert for keyboard and no-CSS cases, not just visually
 * dimmed.
 */
export function Pagination({ page, totalPages, basePath }: PaginationProps) {
  if (totalPages <= 1) {
    return null;
  }

  const disabledClass = `${secondaryButtonClass} pointer-events-none opacity-40`;

  return (
    <div className="mt-8 flex items-center justify-center gap-3">
      {page <= 1 ? (
        <span className={disabledClass}>Previous</span>
      ) : (
        <Link
          href={page <= 2 ? basePath : `${basePath}?page=${page - 1}`}
          className={secondaryButtonClass}
        >
          Previous
        </Link>
      )}

      <span className="text-sm opacity-70">
        Page {page} of {totalPages}
      </span>

      {page >= totalPages ? (
        <span className={disabledClass}>Next</span>
      ) : (
        <Link
          href={`${basePath}?page=${page + 1}`}
          className={secondaryButtonClass}
        >
          Next
        </Link>
      )}
    </div>
  );
}
