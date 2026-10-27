import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

export function Scene3() {
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
      initial={{ opacity: 0, x: '-10vw' }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-[80vw] flex flex-row-reverse items-center gap-12">
        <div className="flex-1">
          <motion.div
            className="w-16 h-1 bg-[var(--color-provider)] mb-6 rounded-full"
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
            Grow Your<br/>
            <span className="text-[var(--color-provider)]">Business</span>
          </motion.h2>
          <motion.p 
            className="text-[2vw] text-[var(--color-text-secondary)]"
            initial={{ opacity: 0 }}
            animate={phase >= 3 ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.6 }}
          >
            Reach more customers. Get paid instantly. Manage it all in one place.
          </motion.p>
        </div>

        <div className="flex-1 flex justify-center relative">
          <motion.div 
            className="w-[30vw] h-[35vw] bg-[var(--color-bg-light)] border border-white/10 rounded-3xl shadow-2xl overflow-hidden relative flex flex-col p-8"
            initial={{ opacity: 0, rotateY: 30, x: -50, z: -100 }}
            animate={phase >= 2 ? { opacity: 1, rotateY: 0, x: 0, z: 0 } : { opacity: 0, rotateY: 30, x: -50, z: -100 }}
            transition={{ type: 'spring', stiffness: 100, damping: 20 }}
            style={{ perspective: 1000 }}
          >
            <div className="h-8 w-full border-b border-white/10 mb-6 flex items-center justify-between">
               <div className="w-1/3 h-2 bg-white/20 rounded-full" />
               <div className="w-12 h-4 bg-[var(--color-success)] rounded-full" />
            </div>
            
            <div className="flex flex-col gap-6">
              {[1, 2, 3].map((item, i) => (
                <motion.div 
                  key={item}
                  className="w-full h-16 bg-white/5 rounded-xl border border-white/5 flex items-center px-4 gap-4"
                  initial={{ opacity: 0, x: -20 }}
                  animate={phase >= 3 ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
                  transition={{ delay: i * 0.2 }}
                >
                  <div className="w-10 h-10 rounded-full bg-[var(--color-provider)]/20" />
                  <div className="flex flex-col gap-2 flex-1">
                     <div className="w-1/2 h-2 bg-white/40 rounded-full" />
                     <div className="w-1/3 h-2 bg-white/20 rounded-full" />
                  </div>
                  <div className="w-16 h-4 bg-[var(--color-primary)]/30 rounded-full" />
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}