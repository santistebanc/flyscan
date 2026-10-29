/** All interface icons share one canvas, size and rounded outline. */
const drawings = {
  cancel: <path d="m6 6 12 12M18 6 6 18" />,
  retry: <><path d="M20 4v6h-6" /><path d="M20 10a8 8 0 1 0 .4 7" /></>,
  queue: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  person: <><circle cx="12" cy="7" r="3" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 6-6 6 6 6" />,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
  "arrow-up": <path d="M12 20V4m-6 6 6-6 6 6" />,
  external: <><path d="M14 4h6v6m0-6-9 9" /><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  done: <><circle cx="12" cy="12" r="9" /><path d="m7.5 12 3 3 6-6" /></>,
  failed: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></>,
  input: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 2.5M12 17h.01" /></>,
  waiting: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  cancelled: <><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>,
  spinner: <path d="M21 12a9 9 0 1 1-9-9" />,
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  price: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M6 12h.01M18 12h.01" /></>,
  stops: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><path d="M7 12h10M12 9v6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  edit: <><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>,
  connection: <><path d="M4 7h5a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3h5M16 13l4 4-4 4" /><circle cx="4" cy="7" r="2" /></>,
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
