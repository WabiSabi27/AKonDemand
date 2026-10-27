import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 300),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 3200), // exit
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center z-10"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 1.2, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      
      <div className="flex items-center gap-12 relative">
        <motion.div
          className="w-[20vw] h-[20vw] rounded-full bg-[var(--color-accent)]/20 border-2 border-[var(--color-accent)] flex flex-col items-center justify-center p-8 text-center"
          initial={{ x: -100, opacity: 0 }}
          animate={phase >= 1 ? { x: 0, opacity: 1 } : { x: -100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          <span className="text-[2vw] font-display font-bold text-white mb-2">Customers</span>
          <span className="text-[1.2vw] text-white/70">Need Help</span>
        </motion.div>

        <motion.div
          className="h-[2px] w-[10vw] bg-white/30 overflow-hidden relative"
          initial={{ opacity: 0 }}
          animate={phase >= 2 ? { opacity: 1 } : { opacity: 0 }}
        >
          <motion.div 
            className="absolute top-0 left-0 bottom-0 bg-[var(--color-primary)]"
            initial={{ width: "0%" }}
            animate={phase >= 2 ? { width: "100%" } : { width: "0%" }}
            transition={{ duration: 1, ease: "easeInOut" }}
          />
        </motion.div>

        <motion.div
          className="w-[20vw] h-[20vw] rounded-full bg-[var(--color-provider)]/20 border-2 border-[var(--color-provider)] flex flex-col items-center justify-center p-8 text-center"
          initial={{ x: 100, opacity: 0 }}
          animate={phase >= 1 ? { x: 0, opacity: 1 } : { x: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          <span className="text-[2vw] font-display font-bold text-white mb-2">Providers</span>
          <span className="text-[1.2vw] text-white/70">Offer Skills</span>
        </motion.div>
      </div>

      <motion.div
        className="mt-12 text-center"
        initial={{ opacity: 0, y: 30 }}
        animate={phase >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
        transition={{ delay: 0.5, duration: 0.8 }}
      >
        <h2 className="text-[4vw] font-display font-bold text-white">
          We Connect <span className="text-[var(--color-primary)]">Juneau</span>
        </h2>
      </motion.div>
      
    </motion.div>
  );
}