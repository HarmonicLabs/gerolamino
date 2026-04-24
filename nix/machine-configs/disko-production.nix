# Disko disk layout for the production NixOS machine.
#
# Target: single-disk UEFI install. The current host is a 297 GiB KVM
# virtual disk surfaced as `/dev/sda` with by-id
# `scsi-0QEMU_QEMU_HARDDISK_drive-scsi0`. We use the by-id path so a reboot
# that re-enumerates devices (rare, but possible on virtio→scsi controller
# changes) doesn't break the pool.
#
# Partition plan:
#   part1  — ESP   1 GiB   /boot (vfat, umask=0077)
#   part2  — swap  32 GiB  (with `discard` for SSD-backed hosts)
#   part3  — ZFS   rest    zpool "zroot"
#
# ZFS datasets:
#   zroot       mountpoint=none   (canmount=off implied by disko layout)
#   zroot/root  mountpoint=/
#   zroot/nix   mountpoint=/nix   (compression=zstd, atime=off inherited)
#   zroot/data  mountpoint=/data  (recordsize=1M for LSM segment files;
#                                  auto-snapshot enabled — we want rollback
#                                  safety on the cardano-node + Mithril
#                                  state, not on the rest of the system)
#
# If we ever add a second NVMe on the physical migration, change `mode`
# from "" (single-disk stripe) to "mirror" and add the sibling `disk.sdb`
# block back in.
{ ... }: {
  disko.devices = {
    # Key name drives the generated partition labels (`disk-sda-ESP`,
    # `disk-sda-swap`). The Hetzner VPS at 178.156.252.81 was originally
    # installed with `disk.sda`; keeping that key preserves fstab
    # compatibility across deploy-rs switches without touching the pool.
    disk.sda = {
      type = "disk";
      device = "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_drive-scsi0";
      content = {
        type = "gpt";
        partitions = {
          ESP = {
            size = "1G";
            type = "EF00";
            content = {
              type = "filesystem";
              format = "vfat";
              mountpoint = "/boot";
              mountOptions = [ "umask=0077" ];
            };
          };
          swap = {
            size = "32G";
            content = {
              type = "swap";
              discardPolicy = "both";
            };
          };
          zfs = {
            size = "100%";
            content = {
              type = "zfs";
              pool = "zroot";
            };
          };
        };
      };
    };

    zpool.zroot = {
      type = "zpool";
      mode = "";
      rootFsOptions = {
        compression = "zstd";
        acltype = "posixacl";
        xattr = "sa";
        atime = "off";
        "com.sun:auto-snapshot" = "false";
      };
      options = {
        ashift = "12";
      };
      datasets = {
        root = {
          type = "zfs_fs";
          mountpoint = "/";
        };
        nix = {
          type = "zfs_fs";
          mountpoint = "/nix";
        };
        data = {
          type = "zfs_fs";
          mountpoint = "/data";
          options = {
            recordsize = "1M";
            "com.sun:auto-snapshot" = "true";
          };
        };
      };
    };
  };
}
