# Disko layout for the relay-only VPS (87.99.129.190).
#
# Hetzner CPX is **BIOS/Legacy** only (`/sys/firmware/efi` absent). Use GRUB
# with a 1 MiB EF02 bios_grub partition; systemd-boot cannot boot here.
#
# `sdb` (250 GiB HC Volume) is left untouched.
{ ... }: {
  disko.devices = {
    disk.sda = {
      type = "disk";
      device = "/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_118886326";
      content = {
        type = "gpt";
        partitions = {
          bios = {
            size = "1M";
            type = "EF02";
          };
          root = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/";
            };
          };
        };
      };
    };
  };
}
