'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Model picker.
 *
 * A native `<select>` renders its popup with the operating system, which
 * cannot be styled at all — on Windows that is a white list with a blue
 * highlight, dropped into the middle of a warm dark UI. This is the listbox
 * pattern instead: a button plus an owned popup.
 *
 * The cost of leaving `<select>` behind is the keyboard behaviour it gave for
 * free, so it is reimplemented here rather than dropped — arrow keys, Home,
 * End, Enter, Escape, click-outside, and roving `aria-activedescendant`. A
 * prettier control that traps keyboard users is a worse control.
 */
export interface ModelOption {
  provider: string
  model: string
}

export function ModelPicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: ModelOption[]
  value: ModelOption | null
  onChange: (v: ModelOption) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selectedIndex = options.findIndex(
    (o) => o.provider === value?.provider && o.model === value?.model,
  )

  const close = useCallback(() => setOpen(false), [])

  // Open at the current selection, not at the top — otherwise every open
  // starts the keyboard user back at item one.
  const toggle = useCallback(() => {
    if (disabled) return
    setActive(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen((v) => !v)
  }, [disabled, selectedIndex])

  useEffect(() => {
    if (!open) return

    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    // `mousedown`, not `click`: a click that starts inside the popup and ends
    // outside would otherwise close it mid-selection.
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  const commit = useCallback(
    (i: number) => {
      const opt = options[i]
      if (opt) onChange(opt)
      close()
    },
    [options, onChange, close],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActive((i) => Math.min(i + 1, options.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setActive((i) => Math.max(i - 1, 0))
          break
        case 'Home':
          e.preventDefault()
          setActive(0)
          break
        case 'End':
          e.preventDefault()
          setActive(options.length - 1)
          break
        case 'Enter':
        case ' ':
          e.preventDefault()
          commit(active)
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    },
    [active, options.length, commit, close],
  )

  if (options.length === 0) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-faint transition-colors hover:bg-raised hover:text-muted disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <span className="max-w-52 truncate">
          {value ? `${value.provider} / ${value.model}` : 'model'}
        </span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5L5 6.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label="Model"
          aria-activedescendant={`model-opt-${active}`}
          onKeyDown={onKeyDown}
          className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-max min-w-56 overflow-y-auto rounded-xl border border-line bg-raised p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.85)] outline-none"
        >
          {options.map((o, i) => {
            const selected = i === selectedIndex
            return (
              <li
                key={`${o.provider}:${o.model}`}
                id={`model-opt-${i}`}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                  i === active ? 'bg-surface text-text' : 'text-muted'
                }`}
              >
                {/* Selection is marked by a glyph, not only by highlight —
                    the highlight already means "keyboard cursor is here". */}
                <span className={`w-3 shrink-0 ${selected ? 'text-clay' : 'opacity-0'}`}>✓</span>
                <span className="truncate">
                  <span className="text-faint">{o.provider}</span>
                  <span className="mx-1 text-faint">/</span>
                  {o.model}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
