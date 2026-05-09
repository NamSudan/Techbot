"use client";

import { useState } from "react";
import {
  FileText,
  Tag,
  Plus,
  X,
  Search,
  ChevronDown,
  ChevronRight,
  File,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Document } from "@/app/page";

interface DocumentSidebarProps {
  documents: Document[];
  allTags: string[];
  selectedTags: string[];
  onTagSelect: (tags: string[]) => void;
  onAddTag: (docId: string, tag: string) => void;
  onRemoveTag: (docId: string, tag: string) => void;
}

const tagColors: Record<string, string> = {
  "kết cấu": "bg-blue-500/20 text-blue-400 border-blue-500/30",
  "P&ID": "bg-purple-500/20 text-purple-400 border-purple-500/30",
  PCCC: "bg-red-500/20 text-red-400 border-red-500/30",
  "vật tư": "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "tầng 1": "bg-green-500/20 text-green-400 border-green-500/30",
  Q2: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
};

const getTagColor = (tag: string) =>
  tagColors[tag] || "bg-muted text-muted-foreground border-border";

export function DocumentSidebar({
  documents,
  allTags,
  selectedTags,
  onTagSelect,
  onAddTag,
  onRemoveTag,
}: DocumentSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedDocs, setExpandedDocs] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState<string | null>(null);
  const [newTagValue, setNewTagValue] = useState("");

  const toggleTagFilter = (tag: string) => {
    if (selectedTags.includes(tag)) {
      onTagSelect(selectedTags.filter((t) => t !== tag));
    } else {
      onTagSelect([...selectedTags, tag]);
    }
  };

  const toggleDocExpand = (docId: string) => {
    setExpandedDocs((prev) =>
      prev.includes(docId)
        ? prev.filter((id) => id !== docId)
        : [...prev, docId]
    );
  };

  const handleAddNewTag = (docId: string) => {
    if (newTagValue.trim()) {
      onAddTag(docId, newTagValue.trim());
      setNewTagValue("");
      setNewTagInput(null);
    }
  };

  const filteredDocs = documents.filter((doc) => {
    const matchesSearch = doc.name
      .toLowerCase()
      .includes(searchQuery.toLowerCase());
    const matchesTags =
      selectedTags.length === 0 ||
      selectedTags.some((tag) => doc.tags.includes(tag));
    return matchesSearch && matchesTags;
  });

  return (
    <aside className="flex w-72 flex-col border-r border-border bg-card">
      {/* Header */}
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-2 text-foreground">
          <FileText className="h-5 w-5 text-primary" />
          <span className="font-semibold">Tài liệu</span>
          <Badge variant="secondary" className="ml-auto">
            {documents.length}
          </Badge>
        </div>
      </div>

      {/* Search */}
      <div className="p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Tìm kiếm tài liệu..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-secondary/50 border-border"
          />
        </div>
      </div>

      {/* Tag Filters */}
      <div className="border-b border-border px-3 pb-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Tag className="h-3 w-3" />
          <span>Lọc theo thẻ</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => toggleTagFilter(tag)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all",
                selectedTags.includes(tag)
                  ? getTagColor(tag)
                  : "bg-secondary/50 text-muted-foreground border-border hover:bg-secondary"
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
        {filteredDocs.map((doc) => {
          const isExpanded = expandedDocs.includes(doc.id);
          const isAddingTag = newTagInput === doc.id;

          return (
            <div
              key={doc.id}
              className="mb-2 rounded-lg border border-border bg-secondary/30 overflow-hidden"
            >
              <button
                onClick={() => toggleDocExpand(doc.id)}
                className="flex w-full items-center gap-2 p-3 text-left hover:bg-secondary/50 transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <File className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium text-foreground truncate">
                  {doc.name}
                </span>
              </button>

              {isExpanded && (
                <div className="border-t border-border bg-card/50 p-3">
                  <div className="mb-2 text-xs text-muted-foreground">
                    Loại: {doc.type}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {doc.tags.map((tag) => (
                      <span
                        key={tag}
                        className={cn(
                          "group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
                          getTagColor(tag)
                        )}
                      >
                        {tag}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveTag(doc.id, tag);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}

                    {isAddingTag ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleAddNewTag(doc.id);
                        }}
                        className="inline-flex items-center gap-1"
                      >
                        <Input
                          value={newTagValue}
                          onChange={(e) => setNewTagValue(e.target.value)}
                          placeholder="Thẻ mới..."
                          className="h-6 w-20 text-xs px-2"
                          autoFocus
                          onBlur={() => {
                            if (!newTagValue.trim()) {
                              setNewTagInput(null);
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <button
                        onClick={() => setNewTagInput(doc.id)}
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/30 px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                      >
                        <Plus className="h-3 w-3" />
                        Thêm thẻ
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {filteredDocs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">
              Không tìm thấy tài liệu
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
