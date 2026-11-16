import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../services/api";
import type { Book, BookPage, Dashboard } from "../../services/types";

const isActive = (b: Book) => b.status === "pending" || b.status === "processing";

// Poll only while something is being converted, so an idle library makes no background requests.
const pollWhile = (books: Book[] | undefined) => (books?.some(isActive) ? 2500 : false);

export function useBooks(params: { page: number; page_size: number; q: string; status: string; sort: string }) {
  return useQuery<BookPage>({
    queryKey: ["books", params],
    queryFn: () => api.books(params),
    placeholderData: (prev) => prev,
    refetchInterval: (q) => pollWhile(q.state.data?.items),
  });
}

export function useDashboard() {
  return useQuery<Dashboard>({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
    refetchInterval: (q) => pollWhile(q.state.data?.recent),
  });
}

export function useBook(id: string | undefined) {
  return useQuery<Book>({
    queryKey: ["book", id],
    queryFn: () => api.book(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && isActive(q.state.data) ? 2500 : false),
  });
}

export function useInvalidateLibrary() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["books"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

export function useDeleteBook() {
  const qc = useQueryClient();
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (id: string) => api.deleteBook(id),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: ["book", id] });
      qc.removeQueries({ queryKey: ["reader", id] });
      invalidate();
    },
  });
}

export function useReprocess() {
  const qc = useQueryClient();
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ id, ocr }: { id: string; ocr: boolean }) => api.reprocess(id, ocr),
    onSuccess: (book) => {
      qc.setQueryData(["book", book.id], book);
      invalidate();
    },
  });
}

export function useRemoveFromDevice() {
  const qc = useQueryClient();
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: (id: string) => api.removeFromDevice(id),
    onSuccess: (book) => {
      qc.setQueryData(["book", book.id], book);
      qc.removeQueries({ queryKey: ["reader", book.id] });
      invalidate();
    },
  });
}

export function useUpdateBook() {
  const qc = useQueryClient();
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; title?: string; author?: string | null }) => api.updateBook(id, data),
    onSuccess: (book) => {
      qc.setQueryData(["book", book.id], book);
      invalidate();
    },
  });
}

export { isActive };
