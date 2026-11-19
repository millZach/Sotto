//! dmabuf into a wgpu texture through Vulkan external memory: adapted from cef-rs 156.7.0's
//! `osr_texture_import/{dmabuf,vulkan}.rs` (Apache-2.0 or MIT), without CEF's types. Imports the buffer, copies it into
//! a texture this process owns and waits for the copy, so the producer can have its buffer back.
use ash::vk;
use std::os::fd::{AsRawFd, BorrowedFd, IntoRawFd, RawFd};
use wgpu::hal::api::Vulkan;

pub struct Frame { pub fd: RawFd, pub width: u32, pub height: u32, pub stride: u32, pub offset: u64, pub modifier: u64, pub format: u32 }

const EXTERNAL_STATE: wgpu::TextureUses = wgpu::TextureUses::COPY_SRC.union(wgpu::TextureUses::RESOURCE);

fn formats(code: u32) -> Result<(wgpu::TextureFormat, vk::Format), String> {
    match code {
        0 => Ok((wgpu::TextureFormat::Rgba8Unorm, vk::Format::R8G8B8A8_UNORM)),
        1 => Ok((wgpu::TextureFormat::Bgra8Unorm, vk::Format::B8G8R8A8_UNORM)),
        2 => Ok((wgpu::TextureFormat::Rgba16Float, vk::Format::R16G16B16A16_SFLOAT)),
        _ => Err(format!("unsupported format {code}")),
    }
}

pub unsafe fn import(device: &wgpu::Device, queue: &wgpu::Queue, f: &Frame) -> Result<wgpu::Texture, String> {
    let (wf, vf) = formats(f.format)?;
    let size = wgpu::Extent3d { width: f.width, height: f.height, depth_or_array_layers: 1 };
    let (hal_texture, foreign) = {
        let hal = unsafe { device.as_hal::<Vulkan>() }.ok_or("not Vulkan")?;
        let foreign = if hal.enabled_device_extensions().contains(&ash::ext::queue_family_foreign::NAME) { vk::QUEUE_FAMILY_FOREIGN_EXT } else { vk::QUEUE_FAMILY_EXTERNAL };
        let raw = hal.raw_device();
        let layouts = [vk::SubresourceLayout { offset: f.offset, row_pitch: f.stride as u64, ..Default::default() }];
        let mut modifier = vk::ImageDrmFormatModifierExplicitCreateInfoEXT::default().drm_format_modifier(f.modifier).plane_layouts(&layouts);
        let mut ext = vk::ExternalMemoryImageCreateInfo::default().handle_types(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT);
        let info = vk::ImageCreateInfo::default().image_type(vk::ImageType::TYPE_2D).format(vf)
            .extent(vk::Extent3D { width: f.width, height: f.height, depth: 1 }).mip_levels(1).array_layers(1).samples(vk::SampleCountFlags::TYPE_1)
            .tiling(vk::ImageTiling::DRM_FORMAT_MODIFIER_EXT).usage(vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::SAMPLED)
            .sharing_mode(vk::SharingMode::EXCLUSIVE).push_next(&mut modifier).push_next(&mut ext);
        let image = unsafe { raw.create_image(&info, None) }.map_err(|e| format!("create image {e:?}"))?;
        let req = unsafe { raw.get_image_memory_requirements(image) };
        let fd = unsafe { BorrowedFd::borrow_raw(f.fd) }.try_clone_to_owned().map_err(|e| format!("dup {e}"))?;
        let ext_fd = ash::khr::external_memory_fd::Device::new(hal.shared_instance().raw_instance(), raw);
        let mut props = vk::MemoryFdPropertiesKHR::default();
        if let Err(e) = unsafe { ext_fd.get_memory_fd_properties(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT, fd.as_raw_fd(), &mut props) } {
            unsafe { raw.destroy_image(image, None) }; return Err(format!("fd properties {e:?}"));
        }
        let mem_props = unsafe { hal.shared_instance().raw_instance().get_physical_device_memory_properties(hal.raw_physical_device()) };
        let bits = req.memory_type_bits & props.memory_type_bits;
        let Some(index) = (0..mem_props.memory_type_count).find(|i| bits & (1 << i) != 0) else { unsafe { raw.destroy_image(image, None) }; return Err("no memory type".into()) };
        let mut import = vk::ImportMemoryFdInfoKHR::default().handle_type(vk::ExternalMemoryHandleTypeFlags::DMA_BUF_EXT).fd(fd.as_raw_fd());
        let mut dedicated = vk::MemoryDedicatedAllocateInfo::default().image(image);
        let alloc = vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(index).push_next(&mut import).push_next(&mut dedicated);
        let memory = match unsafe { raw.allocate_memory(&alloc, None) } { Ok(m) => m, Err(e) => { unsafe { raw.destroy_image(image, None) }; return Err(format!("import memory {e:?}")) } };
        let _ = fd.into_raw_fd(); // Vulkan owns it now
        if let Err(e) = unsafe { raw.bind_image_memory(image, memory, 0) } { unsafe { raw.destroy_image(image, None); raw.free_memory(memory, None) }; return Err(format!("bind {e:?}")) }
        let t = unsafe { hal.texture_from_raw(image, &wgpu::hal::TextureDescriptor {
            label: Some("dmabuf"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wf,
            usage: wgpu::TextureUses::COPY_SRC | wgpu::TextureUses::RESOURCE, memory_flags: wgpu::hal::MemoryFlags::empty(), view_formats: vec![],
        }, None, wgpu::hal::vulkan::TextureMemory::Dedicated(memory)) };
        (t, foreign)
    };
    let source = unsafe { device.create_texture_from_hal::<Vulkan>(hal_texture, &wgpu::TextureDescriptor {
        label: Some("dmabuf"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wf,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, EXTERNAL_STATE) };
    let (raw, local, image) = unsafe { let h = device.as_hal::<Vulkan>().unwrap(); let t = source.as_hal::<Vulkan>().unwrap(); (h.raw_device().clone(), h.queue_family_index(), t.raw_handle()) };
    let dest = device.create_texture(&wgpu::TextureDescriptor { label: Some("owned frame"), size, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wf,
        usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
    let acquire = transfer(device, &raw, image, foreign, local, true)?;
    let mut copy = device.create_command_encoder(&Default::default());
    copy.copy_texture_to_texture(source.as_image_copy(), dest.as_image_copy(), size);
    copy.transition_resources(std::iter::empty(), std::iter::once(wgpu::TextureTransition { texture: &source, selector: None, state: EXTERNAL_STATE }));
    let release = transfer(device, &raw, image, local, foreign, false)?;
    let sub = queue.submit([acquire, copy.finish(), release]);
    device.poll(wgpu::PollType::Wait { submission_index: Some(sub), timeout: None }).map_err(|e| format!("wait {e}"))?;
    Ok(dest)
}

fn transfer(device: &wgpu::Device, raw: &ash::Device, image: vk::Image, from: u32, to: u32, acquire: bool) -> Result<wgpu::CommandBuffer, String> {
    let mut enc = device.create_command_encoder(&Default::default());
    let barrier = vk::ImageMemoryBarrier::default().image(image)
        .subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 })
        .src_queue_family_index(from).dst_queue_family_index(to).old_layout(vk::ImageLayout::GENERAL).new_layout(vk::ImageLayout::GENERAL)
        .src_access_mask(if acquire { vk::AccessFlags::empty() } else { vk::AccessFlags::MEMORY_READ })
        .dst_access_mask(if acquire { vk::AccessFlags::MEMORY_READ } else { vk::AccessFlags::empty() });
    unsafe {
        enc.as_hal_mut::<Vulkan, _, _>(|h| {
            let h = h.ok_or("no hal encoder")?;
            raw.cmd_pipeline_barrier(h.raw_handle(), if acquire { vk::PipelineStageFlags::TOP_OF_PIPE } else { vk::PipelineStageFlags::ALL_COMMANDS },
                if acquire { vk::PipelineStageFlags::ALL_COMMANDS } else { vk::PipelineStageFlags::BOTTOM_OF_PIPE }, vk::DependencyFlags::empty(), &[], &[], &[barrier]);
            Ok::<_, String>(())
        })?;
    }
    Ok(enc.finish())
}

/// Reads a 32x20 grid of pixels back from a texture: how many are not black, and a hash to tell frames apart.
pub fn sample(device: &wgpu::Device, queue: &wgpu::Queue, t: &wgpu::Texture) -> serde_json::Value {
    let (w, h) = (t.width(), t.height());
    let bpp = if t.format() == wgpu::TextureFormat::Rgba16Float { 8 } else { 4 };
    let row = (w * bpp).div_ceil(256) * 256;
    let buf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut enc = device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(t.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } }, t.size());
    queue.submit([enc.finish()]);
    buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = buf.slice(..).get_mapped_range().expect("mapped");
    let half = |b: &[u8]| { let v = u16::from_le_bytes([b[0], b[1]]); let e = ((v >> 10) & 31) as i32; let m = (v & 1023) as f32; if e == 0 { m / 1024.0 * 2f32.powi(-14) } else { (1.0 + m / 1024.0) * 2f32.powi(e - 15) } };
    let (mut nonblack, mut hash, mut sum) = (0u32, 1469598103934665603u64, 0f64);
    let mut first = [0u8; 4];
    for gy in 0..20 { for gx in 0..32 {
        let (x, y) = (gx * w / 32 + w / 64, gy * h / 20 + h / 40);
        let o = (y * row + x * bpp) as usize;
        let rgb: [u8; 3] = if bpp == 8 { [0, 2, 4].map(|i| (half(&data[o + i..]).clamp(0.0, 1.0) * 255.0) as u8) } else { [data[o], data[o + 1], data[o + 2]] };
        if gx == 0 && gy == 0 { first = [rgb[0], rgb[1], rgb[2], data[o + 3]]; }
        if *rgb.iter().max().unwrap() > 16 { nonblack += 1; }
        for b in rgb { hash = (hash ^ b as u64).wrapping_mul(1099511628211); sum += b as f64; }
    } }
    drop(data);
    serde_json::json!({ "nonblack": nonblack, "of": 640, "mean": (sum / 1920.0 * 10.0).round() / 10.0, "hash": format!("{hash:016x}"), "first_px": first })
}
