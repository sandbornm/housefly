//! Deterministic current-based LIF dynamics, with immutable structural weights.
use std::rc::Rc;

pub const DT_MS: f64 = 0.2;
pub const DELAY_TICKS: u64 = 9;
pub const REFRACTORY_TICKS: u64 = 11;
pub const INPUT_CHANNELS: usize = 32;
pub const INPUTS_PER_CHANNEL: usize = 16;
pub const OUTPUT_POOLS: usize = 128;
pub const REST_MV: f64 = -52.0;
pub const INPUT_MV: f64 = 68.75;
// Rounded once from exp(-dt/tau), shared by native and WASM builds.
const EM: f64 = 0.9900498337491681;
const ES: f64 = 0.9607894391523232;
const ET: f64 = 0.9960079893439915;
const COUPLING: f64 = (EM - ES) / 3.0;

pub struct Graph {
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
    /// Signed structural contact counts, never fitted policy weights.
    pub weights: Vec<i32>,
    pub inputs: Vec<u32>,
    pub pools: Vec<u16>,
    pool_sizes: [u32; OUTPUT_POOLS],
}

impl Graph {
    pub fn new(nodes: usize, edges: usize) -> Self {
        Self {
            offsets: vec![0; nodes + 1],
            targets: vec![0; edges],
            weights: vec![0; edges],
            inputs: vec![],
            pools: vec![u16::MAX; nodes],
            pool_sizes: [0; OUTPUT_POOLS],
        }
    }
    pub fn validate(&mut self) -> Result<(), &'static str> {
        let n = self.pools.len();
        if n == 0
            || self.offsets.len() != n + 1
            || self.offsets[0] != 0
            || self.offsets[n] as usize != self.targets.len()
            || self.targets.len() != self.weights.len()
            || self.offsets.windows(2).any(|w| w[0] > w[1])
            || self.targets.iter().any(|&x| x as usize >= n)
            || self.inputs.len() > INPUT_CHANNELS * INPUTS_PER_CHANNEL
        {
            return Err("invalid graph dimensions");
        }
        let mut seen = vec![false; n];
        for &i in &self.inputs {
            if i as usize >= n || seen[i as usize] || self.pools[i as usize] != u16::MAX {
                return Err("invalid or directly driven output group");
            }
            seen[i as usize] = true;
        }
        self.pool_sizes.fill(0);
        for &p in &self.pools {
            if p != u16::MAX {
                if p as usize >= OUTPUT_POOLS {
                    return Err("invalid output pool");
                }
                self.pool_sizes[p as usize] += 1;
            }
        }
        Ok(())
    }
    pub fn node_count(&self) -> usize {
        self.pools.len()
    }
}

pub struct Network {
    pub graph: Rc<Graph>,
    /// Voltage deviation from rest and current-equivalent voltage, in mV.
    pub v: Vec<f64>,
    pub g: Vec<f64>,
    until: Vec<u64>,
    active: Vec<u32>,
    is_active: Vec<bool>,
    last: Vec<u64>,
    pending: [Vec<u32>; 10],
    pub tick: u64,
    pub total_spikes: u64,
    pub silenced: bool,
    seed: u32,
    rng: u32,
    pub input_rates: [f32; INPUT_CHANNELS],
    pub spikes: Vec<u32>,
    pub counts: Vec<u16>,
    traces: [f64; OUTPUT_POOLS],
    pub rates: [f32; OUTPUT_POOLS],
    pub levels: Vec<f32>,
}

fn power(mut base: f64, mut exponent: u64) -> f64 {
    let mut result = 1.0;
    while exponent > 0 {
        if exponent & 1 == 1 {
            result *= base;
        }
        base *= base;
        exponent >>= 1;
    }
    result
}

impl Network {
    pub fn new(graph: Rc<Graph>, seed: u32) -> Self {
        let n = graph.node_count();
        Self {
            graph,
            v: vec![0.0; n],
            g: vec![0.0; n],
            until: vec![0; n],
            active: vec![],
            is_active: vec![false; n],
            last: vec![0; n],
            pending: std::array::from_fn(|_| vec![]),
            tick: 0,
            total_spikes: 0,
            silenced: false,
            seed,
            rng: seed.max(1),
            input_rates: [0.0; INPUT_CHANNELS],
            spikes: vec![],
            counts: vec![0; n],
            traces: [0.0; OUTPUT_POOLS],
            rates: [0.0; OUTPUT_POOLS],
            levels: vec![0.0; n],
        }
    }
    pub fn reset(&mut self, seed: u32) {
        self.seed = seed;
        self.rng = seed.max(1);
        self.tick = 0;
        self.total_spikes = 0;
        self.clear_state();
    }
    fn clear_state(&mut self) {
        self.v.fill(0.0);
        self.g.fill(0.0);
        self.until.fill(0);
        self.last.fill(self.tick);
        self.active.clear();
        self.is_active.fill(false);
        for queue in &mut self.pending {
            queue.clear();
        }
        self.spikes.clear();
        self.counts.fill(0);
        self.traces.fill(0.0);
        self.rates.fill(0.0);
        self.levels.fill(0.0);
    }
    pub fn silence(&mut self, enabled: bool) {
        if enabled {
            self.clear_state();
        }
        self.silenced = enabled;
    }
    fn uniform(&mut self) -> f64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng as f64 + 0.5) / 4294967296.0
    }
    fn catch_up(&mut self, i: usize) {
        let elapsed = self.tick - self.last[i];
        if elapsed > 0 {
            let m = power(EM, elapsed);
            let s = power(ES, elapsed);
            self.v[i] = self.v[i] * m + self.g[i] * (m - s) / 3.0;
            self.g[i] *= s;
            self.last[i] = self.tick;
        }
    }
    fn activate(&mut self, i: usize) {
        if !self.is_active[i] {
            self.catch_up(i);
            self.is_active[i] = true;
            self.active.push(i as u32);
        }
    }
    /// Boundary impulse used by fixture tools. Production stimuli use advance().
    pub fn inject(&mut self, i: usize, voltage_mv: f64, current_mv: f64) {
        if self.silenced || self.tick < self.until[i] {
            return;
        }
        self.activate(i);
        self.v[i] += voltage_mv;
        self.g[i] += current_mv;
    }
    fn step(&mut self, poisson_limits: &[f64; INPUT_CHANNELS]) {
        let slot = self.tick as usize % 10;
        let mut arrivals = std::mem::take(&mut self.pending[slot]);
        for &pre in &arrivals {
            let start = self.graph.offsets[pre as usize] as usize;
            let end = self.graph.offsets[pre as usize + 1] as usize;
            for edge in start..end {
                let weight = self.graph.weights[edge];
                if weight != 0 {
                    let post = self.graph.targets[edge] as usize;
                    self.inject(post, 0.0, weight as f64 * 0.275);
                }
            }
        }
        arrivals.clear();
        self.pending[slot] = arrivals;
        for j in 0..self.graph.inputs.len() {
            let channel = j / INPUTS_PER_CHANNEL;
            if self.input_rates[channel] == 0.0 {
                continue;
            }
            // Knuth's Poisson sampler, including rare multiple events within a bin.
            let limit = poisson_limits[channel];
            let mut product = self.uniform();
            let mut count = 0;
            while product > limit {
                count += 1;
                product *= self.uniform();
            }
            if count > 0 {
                self.inject(self.graph.inputs[j] as usize, INPUT_MV * count as f64, 0.0);
            }
        }
        for trace in &mut self.traces {
            *trace *= ET;
        }
        let next = self.tick + 1;
        let mut cursor = 0;
        while cursor < self.active.len() {
            let i = self.active[cursor] as usize;
            if self.tick >= self.until[i] {
                self.v[i] = self.v[i] * EM + self.g[i] * COUPLING;
                self.g[i] *= ES;
                if self.v[i] > 7.0 {
                    self.v[i] = 0.0;
                    self.g[i] = 0.0;
                    self.until[i] = next + REFRACTORY_TICKS;
                    self.spikes.push(i as u32);
                    self.counts[i] += 1;
                    self.total_spikes += 1;
                    let pool = self.graph.pools[i];
                    if pool != u16::MAX {
                        self.traces[pool as usize] +=
                            20.0 / self.graph.pool_sizes[pool as usize] as f64;
                    }
                    self.pending[((next + DELAY_TICKS) % 10) as usize].push(i as u32);
                }
            }
            self.last[i] = next;
            // Tiny passive tails cannot cross threshold. Preserve them exactly and
            // evaluate the same linear solution lazily at the next event/snapshot.
            if self.v[i].abs() < 1e-10 && self.g[i].abs() < 1e-10 {
                self.is_active[i] = false;
                self.active.swap_remove(cursor);
            } else {
                cursor += 1;
            }
        }
        self.tick = next;
    }
    pub fn advance(
        &mut self,
        rates: &[f32; INPUT_CHANNELS],
        steps: u32,
    ) -> Result<(), &'static str> {
        if steps > 5000
            || rates
                .iter()
                .any(|x| !x.is_finite() || *x < 0.0 || *x > 150.0)
        {
            return Err("invalid advance input");
        }
        for &i in &self.spikes {
            self.counts[i as usize] = 0;
        }
        self.spikes.clear();
        self.input_rates = *rates;
        if self.silenced {
            self.tick += steps as u64;
            return Ok(());
        }
        let limits = std::array::from_fn(|i| (-(rates[i] as f64) * DT_MS / 1000.0).exp());
        for _ in 0..steps {
            self.step(&limits);
        }
        Ok(())
    }
    pub fn snapshot(&mut self) {
        for i in 0..self.v.len() {
            let elapsed = self.tick - self.last[i];
            let voltage = if elapsed == 0 {
                self.v[i]
            } else {
                let m = power(EM, elapsed);
                self.v[i] * m + self.g[i] * (m - power(ES, elapsed)) / 3.0
            };
            self.levels[i] = (voltage / 7.0).clamp(-1.0, 1.0) as f32;
        }
        for p in 0..OUTPUT_POOLS {
            self.rates[p] = self.traces[p] as f32;
        }
    }
}

// The ABI is private to the checked TypeScript loader. A builder is consumed by
// graph_finish, and each runtime owns an Rc clone of the immutable sealed graph.
#[unsafe(no_mangle)]
pub extern "C" fn neural_graph_new(nodes: u32, edges: u32) -> *mut Graph {
    if nodes == 0 || nodes > 1_000_000 || edges > 100_000_000 {
        return std::ptr::null_mut();
    }
    let mut graph = Graph::new(nodes as usize, edges as usize);
    graph.inputs = vec![0; 512];
    Box::into_raw(Box::new(graph))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_graph_buffer(graph: *mut Graph, kind: u32) -> *mut u8 {
    let g = unsafe { &mut *graph };
    match kind {
        0 => g.offsets.as_mut_ptr().cast(),
        1 => g.targets.as_mut_ptr().cast(),
        2 => g.weights.as_mut_ptr().cast(),
        3 => g.inputs.as_mut_ptr().cast(),
        4 => g.pools.as_mut_ptr().cast(),
        _ => std::ptr::null_mut(),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_graph_finish(graph: *mut Graph) -> *const Graph {
    let mut g = unsafe { Box::from_raw(graph) };
    if g.validate().is_err() {
        return std::ptr::null();
    }
    Rc::into_raw(Rc::new(*g))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_graph_abort(graph: *mut Graph) {
    drop(unsafe { Box::from_raw(graph) });
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_new(graph: *const Graph, seed: u32) -> *mut Network {
    unsafe {
        Rc::increment_strong_count(graph);
    }
    Box::into_raw(Box::new(Network::new(unsafe { Rc::from_raw(graph) }, seed)))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_free(net: *mut Network) {
    drop(unsafe { Box::from_raw(net) });
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_reset(net: *mut Network, seed: u32) {
    unsafe { &mut *net }.reset(seed);
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_silence(net: *mut Network, enabled: u32) {
    unsafe { &mut *net }.silence(enabled != 0);
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_advance(net: *mut Network, steps: u32) -> u32 {
    let n = unsafe { &mut *net };
    let rates = n.input_rates;
    u32::from(n.advance(&rates, steps).is_ok())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_snapshot(net: *mut Network) {
    unsafe { &mut *net }.snapshot();
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_buffer(net: *mut Network, kind: u32) -> *mut u8 {
    let n = unsafe { &mut *net };
    match kind {
        0 => n.input_rates.as_mut_ptr().cast(),
        1 => n.spikes.as_mut_ptr().cast(),
        2 => n.counts.as_mut_ptr().cast(),
        3 => n.rates.as_mut_ptr().cast(),
        4 => n.levels.as_mut_ptr().cast(),
        _ => std::ptr::null_mut(),
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn neural_stat(net: *const Network, kind: u32) -> f64 {
    let n = unsafe { &*net };
    match kind {
        0 => n.tick as f64,
        1 => n.spikes.len() as f64,
        2 => n.total_spikes as f64,
        3 => u32::from(n.silenced) as f64,
        4 => n.active.len() as f64,
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(weight: i32) -> Rc<Graph> {
        let mut g = Graph::new(3, 2);
        g.offsets = vec![0, 1, 2, 2];
        g.targets = vec![1, 2];
        g.weights = vec![weight, -250];
        g.inputs = vec![0];
        g.pools[1] = 0;
        g.pools[2] = 1;
        g.validate().unwrap();
        Rc::new(g)
    }
    #[test]
    fn zero_input_and_silencing_are_quiet() {
        let mut n = Network::new(fixture(250), 17);
        n.advance(&[0.0; 32], 5000).unwrap();
        assert_eq!(n.total_spikes, 0);
        n.advance(&[150.0; 32], 500).unwrap();
        assert!(n.total_spikes > 0);
        n.silence(true);
        let total = n.total_spikes;
        n.advance(&[150.0; 32], 5000).unwrap();
        n.snapshot();
        assert!(n.spikes.is_empty());
        assert_eq!(n.total_spikes, total);
        assert!(n.rates.iter().all(|&x| x == 0.0));
        assert!(n.levels.iter().all(|&x| x == 0.0));
    }
    #[test]
    fn delay_excitation_inhibition_and_refractory() {
        let mut n = Network::new(fixture(250), 1);
        n.inject(0, INPUT_MV, 0.0);
        n.advance(&[0.0; 32], 1).unwrap();
        assert_eq!(n.spikes, [0]);
        n.advance(&[0.0; 32], 9).unwrap();
        assert_eq!(n.g[1], 0.0);
        n.advance(&[0.0; 32], 1).unwrap();
        assert!(n.g[1] > 0.0);
        assert!(n.v[1] > 0.0);
        n.inject(0, INPUT_MV, INPUT_MV);
        assert_eq!(n.v[0], 0.0);
        assert_eq!(n.g[0], 0.0);
        n.advance(&[0.0; 32], 1).unwrap();
        n.inject(0, INPUT_MV, 0.0);
        n.advance(&[0.0; 32], 1).unwrap();
        assert!(n.spikes.contains(&0));
        n.advance(&[0.0; 32], 200).unwrap();
        assert!(n.total_spikes >= 3);
        assert!(n.v[2] < 0.0);
        let mut inhibitory = Network::new(fixture(-250), 1);
        inhibitory.inject(0, INPUT_MV, 0.0);
        inhibitory.advance(&[0.0; 32], 100).unwrap();
        assert_eq!(inhibitory.total_spikes, 1);
        assert!(inhibitory.v[1] < 0.0);
    }
    #[test]
    fn reset_seed_and_chunking_are_deterministic() {
        let g = fixture(250);
        let mut a = Network::new(g.clone(), 42);
        let mut b = Network::new(g, 42);
        a.advance(&[150.0; 32], 1000).unwrap();
        for _ in 0..10 {
            b.advance(&[150.0; 32], 100).unwrap();
            b.snapshot();
        }
        assert_eq!(a.total_spikes, b.total_spikes);
        assert_eq!(a.v, b.v);
        assert_eq!(a.g, b.g);
        let expected = a.spikes.clone();
        a.reset(42);
        a.advance(&[150.0; 32], 1000).unwrap();
        assert_eq!(a.spikes, expected);
    }
    #[test]
    fn exact_linear_solution_and_invalid_input() {
        let mut n = Network::new(fixture(0), 1);
        n.inject(2, -3.0, 2.0);
        n.advance(&[0.0; 32], 100).unwrap();
        let m = (-1.0_f64).exp();
        let s = (-4.0_f64).exp();
        assert!((n.v[2] - (-3.0 * m + 2.0 * (m - s) / 3.0)).abs() < 1e-12);
        assert!((n.g[2] - 2.0 * s).abs() < 1e-12);
        assert!(n.advance(&[f32::NAN; 32], 1).is_err());
        assert!(n.advance(&[151.0; 32], 1).is_err());
    }
}
