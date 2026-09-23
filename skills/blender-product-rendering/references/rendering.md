# Rendering

Use EEVEE for blockout and fast iteration. Use Cycles for hero product output unless the visual check shows EEVEE already meets the request.

For Cycles, request GPU, enumerate supported devices, enable available non-CPU devices, then record the effective choice. Use adaptive sampling and denoising. Start previews at low resolution and samples; raise both only after composition and materials pass.

Use AgX color management. Adjust exposure so bright metal retains gradients. Use the compositor sparingly for denoise, small contrast or color corrections, and mild glare when the scene contains a real emissive source.

Render animation to a numbered PNG sequence. Encode video afterward so a failed render retains completed frames. Inspect at least the first, last, extreme-motion, exploded, and transition frames. Avoid optical frame interpolation for engineering motion unless the user accepts invented in-between geometry.

Save the `.blend`, source script, previews, final images or video, and a small render report together.
