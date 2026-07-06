import os, sys, torch, torch.distributed as dist
import torch.multiprocessing as mp

def worker(rank):
    os.environ["MASTER_ADDR"] = "127.0.0.1"
    os.environ["MASTER_PORT"] = "29511"
    torch.cuda.set_device(rank)
    dist.init_process_group("nccl", rank=rank, world_size=2)
    t = torch.ones(1024, 1024, device=f"cuda:{rank}") * (rank + 1)
    dist.all_reduce(t)
    torch.cuda.synchronize()
    print(f"rank {rank}: allreduce OK, sum={t[0,0].item()}", flush=True)
    dist.destroy_process_group()

if __name__ == "__main__":
    mp.spawn(worker, nprocs=2)
    print("NCCL_ALLREDUCE_PASS", flush=True)
