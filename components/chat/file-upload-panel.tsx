"use client";

import { useRef, useState } from "react";
import {
  Upload,
  X,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  File,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { UploadedFile } from "@/app/page";

interface FileUploadPanelProps {
  files: UploadedFile[];
  onUpload: (files: FileList) => void;
  onRemove: (fileId: string) => void;
}

const getFileIcon = (type: string) => {
  if (type.startsWith("image/")) return ImageIcon;
  if (type.includes("spreadsheet") || type.includes("excel"))
    return FileSpreadsheet;
  if (type.includes("pdf") || type.includes("document")) return FileText;
  return File;
};

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export function FileUploadPanel({
  files,
  onUpload,
  onRemove,
}: FileUploadPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      onUpload(e.dataTransfer.files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUpload(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <aside className="flex w-80 flex-col border-l border-border bg-card">
      {/* Header */}
      <div className="border-b border-border p-4">
        <div className="flex items-center gap-2 text-foreground">
          <Upload className="h-5 w-5 text-primary" />
          <span className="font-semibold">Tải lên tệp</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Kéo thả hoặc chọn tệp để phân tích
        </p>
      </div>

      {/* Drop Zone */}
      <div className="p-4">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 transition-all",
            isDragging
              ? "border-primary bg-primary/10"
              : "border-border bg-secondary/30 hover:border-primary/50 hover:bg-secondary/50"
          )}
        >
          <div
            className={cn(
              "mb-3 flex h-12 w-12 items-center justify-center rounded-full transition-colors",
              isDragging ? "bg-primary/20" : "bg-secondary"
            )}
          >
            <Upload
              className={cn(
                "h-6 w-6 transition-colors",
                isDragging ? "text-primary" : "text-muted-foreground"
              )}
            />
          </div>
          <p className="text-sm font-medium text-foreground">
            {isDragging ? "Thả tệp tại đây" : "Kéo thả tệp"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            hoặc nhấp để chọn tệp
          </p>
          <p className="mt-2 text-[10px] text-muted-foreground/70">
            DWG, DXF, PDF, XLSX, hình ảnh
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".dwg,.dxf,.pdf,.xlsx,.xls,.png,.jpg,.jpeg,.gif"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-4">
        <div className="space-y-3">
          {files.map((file) => {
            const Icon = getFileIcon(file.type);
            const isComplete = file.status === "complete";
            const isError = file.status === "error";
            const isUploading = file.status === "uploading";

            return (
              <div
                key={file.id}
                className={cn(
                  "group relative rounded-xl border bg-secondary/30 overflow-hidden transition-all",
                  isError ? "border-destructive/50" : "border-border"
                )}
              >
                {/* Preview Thumbnail */}
                {file.preview ? (
                  <div className="relative h-32 w-full bg-black/20">
                    <img
                      src={file.preview}
                      alt={file.name}
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  </div>
                ) : (
                  <div className="flex h-24 w-full items-center justify-center bg-secondary/50">
                    <Icon className="h-10 w-10 text-muted-foreground/50" />
                  </div>
                )}

                {/* File Info */}
                <div className="p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {file.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                      </p>
                    </div>

                    {/* Status Icon */}
                    <div className="shrink-0">
                      {isComplete && (
                        <CheckCircle2 className="h-5 w-5 text-primary" />
                      )}
                      {isError && (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                      )}
                      {isUploading && (
                        <Loader2 className="h-5 w-5 animate-spin text-primary" />
                      )}
                    </div>
                  </div>

                  {/* Progress Bar */}
                  {isUploading && (
                    <div className="mt-2">
                      <Progress value={file.progress} className="h-1.5" />
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {file.progress}% hoàn thành
                      </p>
                    </div>
                  )}
                </div>

                {/* Remove Button */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(file.id)}
                  className="absolute right-2 top-2 h-7 w-7 rounded-full bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/70"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            );
          })}

          {files.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                <FileText className="h-6 w-6 text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground">
                Chưa có tệp nào được tải lên
              </p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Tải lên tệp để bắt đầu phân tích
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Footer Actions */}
      {files.length > 0 && (
        <div className="border-t border-border p-4">
          <Button className="w-full" size="sm">
            <FileText className="mr-2 h-4 w-4" />
            Phân tích {files.filter((f) => f.status === "complete").length} tệp
          </Button>
        </div>
      )}
    </aside>
  );
}
