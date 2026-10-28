export type BookStatus = "pending" | "processing" | "ready" | "needs_ocr" | "failed";

export interface User {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface Job {
  kind: "text" | "ocr";
  status: "queued" | "running" | "retrying" | "succeeded" | "failed" | "canceled";
  progress: number;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  original_filename: string;
  file_size: number;
  page_count: number;
  status: BookStatus;
  status_message: string | null;
  ocr_requested: boolean;
  ocr_used: boolean;
  content_version: number;
  chapter_count: number;
  word_count: number;
  warnings: string[];
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  progress: { percent: number; chapter_index: number; updated_at: string } | null;
  job: Job | null;
}

export interface BookPage {
  items: Book[];
  total: number;
  page: number;
  page_size: number;
}

export interface StorageInfo {
  used_bytes: number;
  limit_bytes: number;
  disk_free_bytes: number;
  warn: boolean;
  full: boolean;
  user_used_bytes: number | null;
  user_limit_bytes: number | null;
}

export interface Dashboard {
  total_books: number;
  ready_books: number;
  processing_books: number;
  words_read_estimate: number;
  continue_reading: Book[];
  recent: Book[];
  storage: StorageInfo;
}

export interface PublicConfig {
  max_upload_mb: number;
  max_pdf_pages: number;
  ocr_enabled: boolean;
}

export interface Section {
  block: number;
  title: string;
  level: number;
}

export interface Chapter {
  index: number;
  title: string;
  level: number;
  start_page: number;
  end_page: number;
  block_count: number;
  word_count: number;
  sections: Section[];
}

export interface Toc {
  content_version: number;
  total_words: number;
  chapters: Chapter[];
}

export interface Block {
  type: "heading" | "paragraph" | "list_item" | "image";
  page: number;
  text?: string | null;
  level?: number | null;
  image?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ChapterContent {
  index: number;
  title: string;
  content_version: number;
  blocks: Block[];
}

export interface SearchHit {
  chapter_index: number;
  chapter_title: string;
  block_index: number;
  page: number;
  snippet: string;
  match_start: number;
  match_length: number;
}

export interface SearchResult {
  query: string;
  total: number;
  truncated: boolean;
  hits: SearchHit[];
}

export interface Progress {
  content_version: number;
  chapter_index: number;
  block_index: number;
  block_offset: number;
  page: number;
  percent: number;
  mode: "book" | "pdf";
  updated_at?: string;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink";

export interface Bookmark {
  id: string;
  kind: "bookmark" | "highlight" | "note";
  content_version: number;
  chapter_index: number;
  block_index: number;
  start_offset: number | null;
  end_block_index: number | null;
  end_offset: number | null;
  page: number | null;
  quote: string | null;
  note: string | null;
  color: HighlightColor | null;
  created_at: string;
  updated_at: string;
}

export type NewBookmark = Omit<Bookmark, "id" | "created_at" | "updated_at" | "color" | "note" | "quote" | "start_offset" | "end_block_index" | "end_offset" | "page"> &
  Partial<Pick<Bookmark, "color" | "note" | "quote" | "start_offset" | "end_block_index" | "end_offset" | "page">>;

export interface Preferences {
  font_family: "serif" | "sans";
  font_size: number;
  line_height: number;
  paragraph_spacing: number;
  margin: number;
  max_width: number;
  theme: "light" | "dark" | "sepia";
  justify: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  font_family: "serif",
  font_size: 19,
  line_height: 1.7,
  paragraph_spacing: 1,
  margin: 32,
  max_width: 680,
  theme: "light",
  justify: false,
};
