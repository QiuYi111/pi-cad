# torch-fem differentiable sensitivity Recipe

Replace every material/load/constraint and geometry placeholder. The observer requires a sensitivity artifact containing an autograd-versus-finite-difference `relativeError`; lack of that validation fails closed. Production uses the CUDA runtime and never falls back.
