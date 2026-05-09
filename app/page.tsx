"use client";

import { useState } from "react";
import { Header } from "@/components/chat/header";
import { RoleTabs } from "@/components/chat/role-tabs";
import { DocumentSidebar } from "@/components/chat/document-sidebar";
import { ChatArea } from "@/components/chat/chat-area";
import { FileUploadPanel } from "@/components/chat/file-upload-panel";

export type Role = "miner" | "engineer" | "operator";

export interface Document {
  id: string;
  name: string;
  type: string;
  tags: string[];
  uploadedAt: Date;
}

export interface UploadedFile {
  id: string;
  name: string;
  type: string;
  size: number;
  preview?: string;
  status: "uploading" | "complete" | "error";
  progress: number;
}

export default function ChatPage() {
  const [selectedRole, setSelectedRole] = useState<Role>("engineer");
  const [documents, setDocuments] = useState<Document[]>([
    {
      id: "1",
      name: "Bản vẽ kết cấu tầng 1.dwg",
      type: "CAD",
      tags: ["kết cấu", "tầng 1"],
      uploadedAt: new Date(),
    },
    {
      id: "2",
      name: "Sơ đồ P&ID hệ thống PCCC.pdf",
      type: "PDF",
      tags: ["P&ID", "PCCC"],
      uploadedAt: new Date(),
    },
    {
      id: "3",
      name: "Bảng vật tư Q2-2024.xlsx",
      type: "Excel",
      tags: ["vật tư", "Q2"],
      uploadedAt: new Date(),
    },
  ]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const allTags = Array.from(new Set(documents.flatMap((d) => d.tags)));

  const handleAddTag = (docId: string, tag: string) => {
    setDocuments((docs) =>
      docs.map((d) =>
        d.id === docId && !d.tags.includes(tag)
          ? { ...d, tags: [...d.tags, tag] }
          : d
      )
    );
  };

  const handleRemoveTag = (docId: string, tag: string) => {
    setDocuments((docs) =>
      docs.map((d) =>
        d.id === docId ? { ...d, tags: d.tags.filter((t) => t !== tag) } : d
      )
    );
  };

  const handleFileUpload = (files: FileList) => {
    const newFiles: UploadedFile[] = Array.from(files).map((file) => ({
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      type: file.type,
      size: file.size,
      preview: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
      status: "uploading" as const,
      progress: 0,
    }));

    setUploadedFiles((prev) => [...prev, ...newFiles]);

    // Simulate upload progress
    newFiles.forEach((newFile) => {
      const interval = setInterval(() => {
        setUploadedFiles((prev) =>
          prev.map((f) => {
            if (f.id === newFile.id) {
              const newProgress = Math.min(f.progress + 20, 100);
              return {
                ...f,
                progress: newProgress,
                status: newProgress === 100 ? "complete" : "uploading",
              };
            }
            return f;
          })
        );
      }, 300);

      setTimeout(() => clearInterval(interval), 1800);
    });
  };

  const handleRemoveFile = (fileId: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  return (
    <div className="flex h-screen flex-col bg-background">
      <Header />
      <RoleTabs selectedRole={selectedRole} onRoleChange={setSelectedRole} />
      
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - Document Tags */}
        <DocumentSidebar
          documents={documents}
          allTags={allTags}
          selectedTags={selectedTags}
          onTagSelect={setSelectedTags}
          onAddTag={handleAddTag}
          onRemoveTag={handleRemoveTag}
        />

        {/* Center - Chat Area */}
        <ChatArea selectedRole={selectedRole} />

        {/* Right Panel - File Upload */}
        <FileUploadPanel
          files={uploadedFiles}
          onUpload={handleFileUpload}
          onRemove={handleRemoveFile}
        />
      </div>
    </div>
  );
}
