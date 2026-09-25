/** The QuizPilot mark: a ring for the question, a check for the answer (also the Q's tail). */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" class="logo">
      <rect width="64" height="64" rx="14" fill="#1B2A4A" />
      <circle cx="29" cy="29" r="15" fill="none" stroke="#F5F2EA" stroke-width="7" />
      <path
        d="M33 37 L40.5 44.5 L54 27"
        fill="none"
        stroke="#E0692E"
        stroke-width="7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** "Quiz" in ink, "Pilot" in the accent. */
export function Wordmark() {
  return (
    <span class="wordmark">
      Quiz<b>Pilot</b>
    </span>
  );
}
