/** All interface icons share one canvas, size and rounded outline. */
const drawings = {
  cancel: <path d="m6 6 12 12M18 6 6 18" />,
  retry: <><path d="M20 4v6h-6" /><path d="M20 10a8 8 0 1 0 .4 7" /></>,
  queue: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  person: <><circle cx="12" cy="7" r="3" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 6-6 6 6 6" />,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
  done: <><circle cx="12" cy="12" r="9" /><path d="m7.5 12 3 3 6-6" /></>,
  failed: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></>,
  input: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 2.5M12 17h.01" /></>,
  waiting: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  cancelled: <><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>,
  spinner: <path d="M21 12a9 9 0 1 1-9-9" />,
};

export function Icon({ name, className = "" }: { name: keyof typeof drawings; className?: string }) {
  return <svg className={`icon${className ? ` ${className}` : ""}`} viewBox="0 0 24 24"
    width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {drawings[name]}
  </svg>;
}

export function Spinner() {
  return <Icon name="spinner" className="spinner" />;
}
