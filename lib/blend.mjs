export const BLENDS = Object.freeze({
 conservador:{coreShare:.8,fastShare:.2,entryPct:1,takeProfitPct:.6,stopPct:.8,cooldownMinutes:15,maxMinutes:240},
 moderado:{coreShare:.5,fastShare:.5,entryPct:4,takeProfitPct:.5,stopPct:1,cooldownMinutes:8,maxMinutes:240},
 agressivo:{coreShare:.3,fastShare:.7,entryPct:8,takeProfitPct:.5,stopPct:1.2,cooldownMinutes:4,maxMinutes:180},
});
export const blendFor = config => BLENDS[config.profile.includes('agressivo')?'agressivo':config.profile.includes('conservador')?'conservador':'moderado'];
