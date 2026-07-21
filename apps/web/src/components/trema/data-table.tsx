import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { EmptyState } from "#/components/trema/empty-state.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "#/components/ui/pagination.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import { cn } from "#/lib/utils.ts";

type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  width?: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
};

type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  pageSize?: number;
  className?: string;
};

const SKELETON_ROW_KEYS = ["s1", "s2", "s3", "s4", "s5"];

type PageItem = number | "start-ellipsis" | "end-ellipsis";

function pageItems(pageCount: number, current: number): PageItem[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, page) => page);
  }
  const items: PageItem[] = [0];
  const start = Math.max(1, current - 1);
  const end = Math.min(pageCount - 2, current + 1);
  if (start > 1) {
    items.push("start-ellipsis");
  }
  for (let page = start; page <= end; page += 1) {
    items.push(page);
  }
  if (end < pageCount - 2) {
    items.push("end-ellipsis");
  }
  items.push(pageCount - 1);
  return items;
}

function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  empty,
  pageSize,
  className,
}: DataTableProps<T>) {
  const [page, setPage] = useState(0);
  const pageCount = pageSize === undefined ? 1 : Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pageCount - 1);
  const visibleRows =
    pageSize === undefined ? rows : rows.slice(current * pageSize, current * pageSize + pageSize);
  const showPagination = pageSize !== undefined && pageCount > 1 && !loading;

  let body: ReactNode;
  if (loading) {
    body = SKELETON_ROW_KEYS.map((skeletonKey) => (
      <TableRow key={skeletonKey} className="hover:bg-transparent">
        {columns.map((column) => (
          <TableCell key={column.key} className="px-3 py-2.5">
            <Skeleton className="h-4 w-2/3" />
          </TableCell>
        ))}
      </TableRow>
    ));
  } else if (visibleRows.length === 0) {
    body = (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={columns.length} className="p-0 whitespace-normal">
          {empty ?? <EmptyState title="No results" />}
        </TableCell>
      </TableRow>
    );
  } else {
    body = visibleRows.map((row) => (
      <TableRow
        key={rowKey(row)}
        className={cn("hover:bg-muted/40", onRowClick !== undefined && "cursor-pointer")}
        onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
        onKeyDown={
          onRowClick === undefined
            ? undefined
            : (event) => {
                if (event.key === "Enter") {
                  onRowClick(row);
                }
              }
        }
        tabIndex={onRowClick === undefined ? undefined : 0}
      >
        {columns.map((column) => (
          <TableCell
            key={column.key}
            className={cn("px-3 py-2.5", column.align === "right" && "text-right")}
          >
            {column.render(row)}
          </TableCell>
        ))}
      </TableRow>
    ));
  }

  return (
    <div
      data-slot="data-table"
      className={cn("overflow-hidden rounded-lg border bg-card", className)}
    >
      <Table className="text-(length:--text-chrome)">
        <TableHeader>
          <TableRow className="bg-muted/60 hover:bg-muted/60">
            {columns.map((column) => (
              <TableHead
                key={column.key}
                className={cn(
                  "h-9 px-3 font-medium text-(length:--text-meta) text-muted-foreground",
                  column.align === "right" && "text-right",
                )}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{body}</TableBody>
      </Table>
      {showPagination ? (
        <div className="border-t px-3 py-2">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-(length:--text-chrome)"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                >
                  <ChevronLeftIcon />
                  Previous
                </Button>
              </PaginationItem>
              {pageItems(pageCount, current).map((item) =>
                item === "start-ellipsis" || item === "end-ellipsis" ? (
                  <PaginationItem key={item}>
                    <PaginationEllipsis className="size-8" />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={`page-${item}`}>
                    <Button
                      variant={item === current ? "outline" : "ghost"}
                      size="icon-sm"
                      className="text-(length:--text-chrome)"
                      aria-current={item === current ? "page" : undefined}
                      onClick={() => setPage(item)}
                    >
                      {item + 1}
                    </Button>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-(length:--text-chrome)"
                  disabled={current === pageCount - 1}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                  <ChevronRightIcon />
                </Button>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      ) : null}
    </div>
  );
}

export { DataTable, type DataTableColumn };
