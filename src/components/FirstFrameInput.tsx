"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type FirstFrameImageOption = { sessionId: string; date: string; imageUrl: string };

type Props = {
  existingImages: FirstFrameImageOption[];
  selectedExistingId: string;
  onSelectExisting: (id: string) => void;
  onFile: (file: File) => void | Promise<void>;
  onRemove?: () => void;
  disabled?: boolean;
  title?: string;
};

const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

export function FirstFrameInput({ existingImages, selectedExistingId, onSelectExisting, onFile, onRemove, disabled = false, title = "首帧图片" }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const selectedExisting = existingImages.find((image) => image.sessionId === selectedExistingId) ?? null;

  // The object URL is external browser state and must be revoked when replaced.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!selectedFile) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const fileDetails = useMemo(() => selectedFile ? `${selectedFile.name} · ${Math.round(selectedFile.size / 1024)} KB` : "", [selectedFile]);

  function acceptFile(file: File | undefined) {
    if (!file || !ACCEPTED.has(file.type)) return;
    setSelectedFile(file);
    void onFile(file);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">{title}</p>
      <div
        className={`rounded-md border border-dashed p-3 text-sm ${dragging ? "border-emerald-500 bg-emerald-50" : "border-stone-300 bg-[#faf8f4]"}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files?.[0]); }}
        onPaste={(event) => acceptFile(Array.from(event.clipboardData.files)[0])}
        tabIndex={0}
      >
        <button className="font-semibold underline" disabled={disabled} onClick={() => inputRef.current?.click()} type="button">点击选择图片</button>
        <span className="ml-1 text-stone-500">或拖拽 / 粘贴 PNG、JPEG、WebP</span>
        <input ref={inputRef} accept="image/png,image/jpeg,image/webp" className="hidden" disabled={disabled} onChange={(event) => acceptFile(event.target.files?.[0])} type="file" />
      </div>
      {previewUrl ? <div className="flex items-center gap-3 rounded-md border border-stone-200 bg-white p-2"><img alt="本地首帧预览" className="h-16 w-24 rounded object-contain bg-black" src={previewUrl} /><div className="min-w-0 text-xs text-stone-600"><p className="truncate">{fileDetails}</p><button className="mt-1 text-rose-700 underline" onClick={() => { setSelectedFile(null); onRemove?.(); }} type="button">移除 / 更换</button></div></div> : null}
      <label className="block text-xs text-stone-600">选择已验证图片
        <select className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2 py-2 text-sm" disabled={disabled} onChange={(event) => onSelectExisting(event.target.value)} value={selectedExistingId}>
          <option value="">请选择本地图片</option>
          {existingImages.map((image) => <option key={image.sessionId} value={image.sessionId}>{image.date} · {image.sessionId}</option>)}
        </select>
      </label>
      {selectedExisting ? <div className="flex items-center gap-3 rounded-md border border-stone-200 bg-white p-2"><img alt="已验证首帧预览" className="h-16 w-24 rounded object-contain bg-black" src={selectedExisting.imageUrl} /><span className="truncate text-xs text-stone-600">{selectedExisting.sessionId}</span></div> : null}
    </div>
  );
}
