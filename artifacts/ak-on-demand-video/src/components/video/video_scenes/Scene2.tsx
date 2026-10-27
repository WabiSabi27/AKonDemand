import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1600),
      setTimeout(() => setPhase(4), 3800), // exit
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center z-10"
      initial={{ opacity: 0, x: '10vw' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, y: '-10vh', filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-[80vw] flex items-center gap-12">
        <div className="flex-1">
          <motion.div
            className="w-16 h-1 bg-[var(--color-accent)] mb-6 rounded-full"
            initial={{ width: 0 }}
            animate={phase >= 1 ? { width: 64 } : { width: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
          <motion.h2 
            className="text-[5vw] leading-[1.1] font-display font-bold text-white mb-6"
            initial={{ opacity: 0, y: 20 }}
            animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
            transition={{ duration: 0.6 }}
          >
            Find Local<br/>
            <span className="text-[var(--color-accent)]">Services Fast</span>
          </motion.h2>
          <motion.p 
            className="text-[2vw] text-[var(--color-text-secondary)]"
            initial={{ opacity: 0 }}
            animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.6 }}
          >
            Browse and book trusted professionals in Juneau.
          </motion.p>
        </div>

        <div className="flex-1 grid grid-cols-2 gap-4 relative">
          {['Cleaning', 'Handyman', 'Plumbing', 'Moving'].map((service, i) => (
            <motion.div 
              key={service}
              className="bg-[var(--color-bg-light)]/80 backdrop-blur-md border border-white/10 rounded-2xl p-6 flex flex-col items-center justify-center"
              initial={{ opacity: 0, scale: 0.8, y: 20 }}
              animate={phase >= 2 ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0, scale: 0.8, y: 20 }}
              transition={{ delay: i * 0.15, type: 'spring', stiffness: 200, damping: 20 }}
            >
              <div className="w-12 h-12 rounded-full bg-[var(--color-accent)]/20 mb-4 flex items-center justify-center">
                <div className="w-6 h-6 bg-[var(--color-accent)] rounded-full" />
              </div>
              <span className="text-[1.5vw] font-medium text-white">{service}</span>
            </motion.div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}