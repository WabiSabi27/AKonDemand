import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

// Using the logo from the attached assets
import logoSrc from '@/../../../artifacts/mobile/assets/images/logo_transparent.png';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 3200), // exit
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center z-10"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={phase >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="mb-8"
      >
        <img src={logoSrc} alt="AK On Demand Logo" className="w-[30vw] max-w-[400px] object-contain drop-shadow-2xl" />
      </motion.div>

      <motion.div className="overflow-hidden">
        <motion.h1 
          className="text-[4vw] font-display font-bold text-white tracking-tight"
          initial={{ y: "100%" }}
          animate={phase >= 2 ? { y: 0 } : { y: "100%" }}
          transition={{ type: 'spring', stiffness: 200, damping: 25 }}
        >
          Your Juneau Marketplace
        </motion.h1>
      </motion.div>
    </motion.div>
  );
}