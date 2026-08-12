"use client";

import { useEffect, useRef, useState } from "react";

type AudioPlaybackState = { position: number; wasPlaying: boolean };
type VideoPlaybackState = { position: number; wasPlaying: boolean };

const audioPositions = new Map<string, number>();
const videoPositions = new Map<string, number>();

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

export function VideoPlayer({ videoId, src, poster, className, controls = true, autoPlay = false, muted = false, unsupported }: { videoId: string; src: string; poster?: string; className?: string; controls?: boolean; autoPlay?: boolean; muted?: boolean; unsupported: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingResume = useRef<VideoPlaybackState | null>(null);
  const [source, setSource] = useState(src);

  // Signed media URLs can be refreshed while a page remains open. Replacing
  // the source normally resets playback to the beginning, so capture and
  // restore the current position when the URL changes.
  useEffect(() => {
    if (source === src) return;
    const video = videoRef.current;
    pendingResume.current = {
      position: video?.currentTime ?? videoPositions.get(videoId) ?? 0,
      wasPlaying: Boolean(video && !video.paused),
    };
    setSource(src);
  }, [source, src, videoId]);

  function rememberPosition(video: HTMLVideoElement) {
    if (Number.isFinite(video.currentTime)) videoPositions.set(videoId, video.currentTime);
  }

  function restorePosition() {
    const video = videoRef.current;
    if (!video) return;
    const resume = pendingResume.current;
    const position = resume?.position ?? videoPositions.get(videoId) ?? 0;
    if (position > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(position, Math.max(0, video.duration - 0.05));
    pendingResume.current = null;
    if ((resume?.wasPlaying || autoPlay) && !video.ended) void video.play().catch(() => undefined);
  }

  return <video ref={videoRef} crossOrigin="use-credentials" className={className} controls={controls} autoPlay={autoPlay} muted={muted} playsInline preload="metadata" poster={poster || undefined} src={source} onLoadedMetadata={restorePosition} onTimeUpdate={(event) => rememberPosition(event.currentTarget)} onPause={(event) => rememberPosition(event.currentTarget)} onEnded={() => { videoPositions.delete(videoId); }}>{unsupported}</video>;
}
