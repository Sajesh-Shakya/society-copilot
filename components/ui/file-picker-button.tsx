"use client";

import { forwardRef, useImperativeHandle, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "@/components/ui/button";

export interface FilePickerButtonHandle {
  /** Clears the shown filename and the underlying input's value, so
   * re-selecting the same file re-fires onFileSelected. Call this from
   * the caller's upload-finished handler (success or failure). */
  reset: () => void;
}

export interface FilePickerButtonProps extends VariantProps<typeof buttonVariants> {
  accept: string;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  loadingLabel?: string;
  noFileLabel?: string;
  onFileSelected: (file: File) => void;
  className?: string;
  /** Passed through to the underlying input -- set these when the caller
   * reads the chosen file from a <form>'s own FormData on submit (e.g.
   * CsvImporter) rather than handling the file immediately on selection. */
  id?: string;
  name?: string;
}

/**
 * A real, clickable button that opens the native file picker, with the
 * chosen filename shown next to it -- never a bare <input type="file">.
 *
 * Why this exists: a bare file input renders as the browser's tiny
 * default "Browse… / Choose File — no file selected" control, which is
 * easy to miss entirely (reported more than once across this app's CSV
 * and XLSX upload pages before this component existed, each fixed
 * independently and at risk of drifting out of sync or regressing again
 * in a fourth upload surface someone adds later). Centralizing the
 * pattern here means there's exactly one implementation to get right.
 *
 * The input itself is visually hidden with `sr-only`, NOT `hidden`/
 * display:none -- several mobile browsers (notably iOS Safari) refuse to
 * open the native file picker for a programmatically-clicked input
 * that's fully display:none, even from a real user gesture. `sr-only`
 * keeps it in the layout (zero-size, clipped, off-screen) which mobile
 * browsers accept.
 *
 * The caller owns the upload itself (this component only hands back the
 * selected File); call the returned ref's `.reset()` once the upload
 * settles so the displayed filename clears and re-picking the same file
 * fires onFileSelected again.
 */
export const FilePickerButton = forwardRef<FilePickerButtonHandle, FilePickerButtonProps>(
  function FilePickerButton(
    {
      accept,
      disabled,
      isLoading,
      label = "Choose file",
      loadingLabel,
      noFileLabel = "No file chosen",
      onFileSelected,
      variant = "outline",
      size,
      className,
      id,
      name,
    },
    ref
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [fileName, setFileName] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      reset() {
        setFileName(null);
        if (inputRef.current) inputRef.current.value = "";
      },
    }));

    function handleChange(e: ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      setFileName(file.name);
      onFileSelected(file);
    }

    return (
      <div className={className ? className : "flex items-center gap-3"}>
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="file"
          accept={accept}
          onChange={handleChange}
          disabled={disabled || isLoading}
          className="sr-only"
        />
        <Button
          type="button"
          variant={variant}
          size={size}
          disabled={disabled || isLoading}
          onClick={() => inputRef.current?.click()}
        >
          {isLoading ? (loadingLabel ?? "Working…") : label}
        </Button>
        <span className="text-sm text-muted-foreground">{fileName ?? noFileLabel}</span>
      </div>
    );
  }
);
