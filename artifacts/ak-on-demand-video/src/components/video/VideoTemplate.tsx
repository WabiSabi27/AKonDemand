import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useVideoPlayer } from '@/lib/video';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';
import { Scene5 } from './video_scenes/Scene5';

export const SCENE_DURATIONS = {
  open: 4000,
  customer: 4500,
  provider: 4500,
  connect: 4000,
  close: 4000,
};

const SCENE_START_SEC: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  let cumulativeMs = 0;
  for (const [key, ms] of Object.entries(SCENE_DURATIONS)) {
    out[key] = cumulativeMs / 1000;
    cumulativeMs += ms;
  }
  return out;
})();

const AUDIO_SEEK_EPSILON_SEC = 0.18;

const SCENE_COMPONENTS: Record<string, React.ComponentType> = {
  open: Scene1,
  customer: Scene2,
  provider: Scene3,
  connect: Scene4,
  close: Scene5,
};

export default function VideoTemplate({
  durations = SCENE_DURATIONS,
  loop = true,
  muted = false,
  onSceneChange,
}: {
  durations?: Record<string, number>;
  loop?: boolean;
  muted?: boolean;
  onSceneChange?: (sceneKey: string) => void;
} = {}) {
  const { currentScene, currentSceneKey } = useVideoPlayer({ durations, loop });

  useEffect(() => {
    onSceneChange?.(currentSceneKey);
  }, [currentSceneKey, onSceneChange]);

  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '') as keyof typeof SCENE_DURATIONS;
  const sceneIndex = Object.keys(SCENE_DURATIONS).indexOf(baseSceneKey);
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];

  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 0.45;
    const targetTime = SCENE_START_SEC[baseSceneKey] ?? 0;
    if (Math.abs(audio.currentTime - targetTime) > AUDIO_SEEK_EPSILON_SEC) {
      audio.currentTime = targetTime;
    }
    audio.play().catch(() => {});
  }, [currentSceneKey, baseSceneKey, muted]);

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[var(--color-bg-dark)] font-body">
      {/* Persistent Background layer */}
      <div className="absolute inset-0 z-0">
        <video
          src={`${import.meta.env.BASE_URL}videos/bg_navy.mp4`}
          className="absolute inset-0 w-full h-full object-cover opacity-60"
          autoPlay
          muted
          loop
          playsInline
        />
        <div className="absolute inset-0 bg-[var(--color-bg-dark)]/40" />
      </div>

      {/* Persistent midground layer */}
      <motion.div
        className="absolute w-[80vw] h-[80vw] rounded-full blur-[120px] mix-blend-screen pointer-events-none"
        animate={{
          background: [
            'radial-gradient(circle, var(--color-primary) 0%, transparent 60%)',
            'radial-gradient(circle, var(--color-accent) 0%, transparent 60%)',
            'radial-gradient(circle, var(--color-provider) 0%, transparent 60%)',
            'radial-gradient(circle, var(--color-primary) 0%, transparent 60%)',
            'radial-gradient(circle, var(--color-primary) 0%, transparent 60%)',
          ][sceneIndex] ?? 'radial-gradient(circle, var(--color-primary) 0%, transparent 60%)',
          x: ['-20vw', '40vw', '-40vw', '10vw', '10vw'][sceneIndex] ?? '10vw',
          y: ['-20vh', '-10vh', '40vh', '10vh', '10vh'][sceneIndex] ?? '10vh',
          opacity: [0.1, 0.15, 0.15, 0.1, 0.1][sceneIndex] ?? 0.1,
          scale: [1, 1.2, 1.1, 1, 1][sceneIndex] ?? 1,
        }}
        transition={{ duration: 2, ease: 'easeInOut' }}
      />

      {/* Grid texture overlay */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-text-primary) 1px, transparent 1px), linear-gradient(90deg, var(--color-text-primary) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      <AnimatePresence mode="popLayout">
        {SceneComponent && <SceneComponent key={currentSceneKey} />}
      </AnimatePresence>

      <audio
        ref={audioRef}
        src={`${import.meta.env.BASE_URL}audio/bg_music.mp3`}
        preload="auto"
        autoPlay
        muted={muted}
      />
    </div>
  );
}
