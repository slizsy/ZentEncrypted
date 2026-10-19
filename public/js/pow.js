// Runs the proof-of-work check in workers.
const Pow = (() => {
  function solve(challenge) {
    return new Promise((resolve, reject) => {
      if (typeof Worker === 'undefined') return reject(new Error('This browser cannot run the human check.'));
      const count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      const workers = [];
      let done = false;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        workers.forEach((w) => w.terminate());
        fn(v);
      };
      const timer = setTimeout(() => finish(reject, new Error('The human check took too long. Try again.')), 60000);
      for (let i = 0; i < count; i++) {
        let w;
        try {
          w = new Worker('/js/pow-worker.js?v=2.4');
        } catch {
          clearTimeout(timer);
          return finish(reject, new Error('The human check could not start.'));
        }
        w.onmessage = (e) => {
          if (e.data && typeof e.data.counter === 'number') {
            clearTimeout(timer);
            finish(resolve, e.data.counter);
          }
        };
        w.onerror = () => { clearTimeout(timer); finish(reject, new Error('The human check failed to run.')); };
        w.postMessage({ n: challenge.n, difficulty: challenge.difficulty, start: i, stride: count });
        workers.push(w);
      }
    });
  }
  return { solve };
})();
