NBOSP_SELINUX_INIT_VERSION = 1
NBOSP_SELINUX_INIT_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-selinux-init
NBOSP_SELINUX_INIT_SITE_METHOD = local
NBOSP_SELINUX_INIT_DEPENDENCIES = libselinux policycoreutils

define NBOSP_SELINUX_INIT_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-init.c -lselinux -o $(@D)/nbosp-init
endef

define NBOSP_SELINUX_INIT_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/nbosp-init \
		$(TARGET_DIR)/sbin/nbosp-init
endef

$(eval $(generic-package))
