use male_cns_lif::{Graph, INPUT_MV, Network};
use std::{fs, path::Path, rc::Rc, time::Instant};

fn u32s(path: &Path) -> Vec<u32> {
    fs::read(path)
        .unwrap()
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .collect()
}

fn graph(root: &Path, zero_edges: bool) -> Rc<Graph> {
    let offsets = u32s(&root.join("offsets.u32.000.bin"));
    let n = offsets.len() - 1;
    let e = *offsets.last().unwrap() as usize;
    let mut g = Graph::new(n, e);
    g.offsets = offsets;
    g.targets.clear();
    g.weights.clear();
    for part in 0..e.div_ceil(3_000_000) {
        g.targets
            .extend(u32s(&root.join(format!("targets.u32.{part:03}.bin"))));
        g.weights.extend(
            u32s(&root.join(format!("weights.i32.{part:03}.bin")))
                .iter()
                .map(|&x| if zero_edges { 0 } else { x as i32 }),
        );
    }
    g.inputs = u32s(&root.join("inputs.u32.000.bin"));
    g.pools = fs::read(root.join("pools.u16.000.bin"))
        .unwrap()
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
        .collect();
    g.validate().unwrap();
    Rc::new(g)
}

fn fixture() {
    let mut g = Graph::new(4, 3);
    g.offsets = vec![0, 2, 3, 3, 3];
    g.targets = vec![1, 2, 3];
    g.weights = vec![250, -250, 250];
    g.validate().unwrap();
    let mut n = Network::new(Rc::new(g), 42);
    println!("tick,v0,g0,v1,g1,v2,g2,v3,g3,spikes");
    for t in 0..500 {
        if [0, 2, 11, 12, 80, 160, 161, 300].contains(&t) {
            n.inject(0, INPUT_MV, 0.0);
        }
        if t == 20 {
            n.inject(2, -3.0, 2.0);
        }
        n.advance(&[0.0; 32], 1).unwrap();
        let spikes: String = (0..4)
            .map(|i| if n.spikes.contains(&i) { '1' } else { '0' })
            .collect();
        println!(
            "{},{:.14},{:.14},{:.14},{:.14},{:.14},{:.14},{:.14},{:.14},{}",
            n.tick,
            n.v[0] - 52.0,
            n.g[0],
            n.v[1] - 52.0,
            n.g[1],
            n.v[2] - 52.0,
            n.g[2],
            n.v[3] - 52.0,
            n.g[3],
            spikes
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "fixture") {
        fixture();
        return;
    }
    let root = Path::new(args.get(1).map(String::as_str).unwrap_or("public/neural"));
    let zero_edges = args.get(2).is_some_and(|a| a == "zero-edges");
    let g = graph(root, zero_edges);
    let mut n = Network::new(g, 42);
    let start = Instant::now();
    n.advance(&[150.0; 32], 5000).unwrap();
    n.snapshot();
    let downstream = n
        .spikes
        .iter()
        .filter(|i| !n.graph.inputs.contains(i))
        .count();
    let hash = n
        .spikes
        .iter()
        .flat_map(|i| i.to_le_bytes())
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    println!(
        "{{\"nativeElapsedMs\":{},\"tick\":{},\"totalSpikes\":{},\"downstreamSpikes\":{},\"spikeFnv64\":\"{:016x}\",\"rates\":{:?}}}",
        start.elapsed().as_secs_f64() * 1000.0,
        n.tick,
        n.total_spikes,
        downstream,
        hash,
        n.rates
    );
}
