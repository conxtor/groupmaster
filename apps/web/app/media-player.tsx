"use client";

import { useEffect, useRef, useState } from "react";

type AudioPlaybackState = { position: number; wasPlaying: boolean };

const audioPositions = new Map<string, number>();

export function AudioPlayer({ messageId, src, label, unsupported }: { messageId: string; src: string; label: string; unsupported: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingResume = useRef<AudioPlaybackState | null>(null);
  const [source, setSource] = useState(src);

  useEffect(() => {
    if (source === src) return;
    const audio = audioRef.current;
    pendingResume.current = {
      position: audio?.currentTime ?? audioPositions.get(messageId) ?? 0,
      wasPlaying: Boolean(audio && !audio.paused),
    };
    setSource(src);
  }, [messageId, source, src]);

  function rememberPosition(audio: HTMLAudioElement) {
    if (Number.isFinite(audio.currentTime)) audioPositions.set(messageId, audio.currentTime);
  }

  function restorePosition() {
    const audio = audioRef.current;
    if (!audio) return;
    const resume = pendingResume.current;
    const position = resume?.position ?? audioPositions.get(messageId) ?? 0;
    if (position > 0 && Number.isFinite(audio.duration)) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 0.05));
    pendingResume.current = null;
    if (resume?.wasPlaying) void audio.play().catch(() => undefined);
  }

  return <figure className="audioPreview">
    <audio ref={audioRef} crossOrigin="use-credentials" controls preload="metadata" src={source} onLoadedMetadata={restorePosition} onTimeUpdate={(event) => rememberPosition(event.currentTarget)} onPause={(event) => rememberPosition(event.currentTarget)} onEnded={() => { audioPositions.delete(messageId); }}>{unsupported}</audio>
    <figcaption>{label}</figcaption>
  </figure>;
}
