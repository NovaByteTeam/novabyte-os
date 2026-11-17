NBOSP_VPN_VERSION = 1
NBOSP_VPN_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-vpn
NBOSP_VPN_SITE_METHOD = local

define NBOSP_VPN_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-vpn.c -o $(@D)/nbosp-vpn
endef

define NBOSP_VPN_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 4755 $(@D)/nbosp-vpn $(TARGET_DIR)/usr/bin/nbosp-vpn
	$(INSTALL) -D -m 0755 $(@D)/S90nbosp-vpn $(TARGET_DIR)/etc/init.d/S90nbosp-vpn
endef

$(eval $(generic-package))
