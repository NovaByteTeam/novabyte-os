NBOSP_KIOSK_VERSION = 1
NBOSP_KIOSK_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-kiosk/source
NBOSP_KIOSK_SITE_METHOD = local

define NBOSP_KIOSK_INSTALL_TARGET_CMDS
	rm -rf $(TARGET_DIR)/opt/nbosp
	$(INSTALL) -d $(TARGET_DIR)/opt/nbosp
	cp -a $(@D)/. $(TARGET_DIR)/opt/nbosp/
	$(INSTALL) -D -m 0755 $(BR2_EXTERNAL_NBOSP_PATH)/board/nbosp/S99nbosp \
		$(TARGET_DIR)/etc/init.d/S99nbosp
endef

$(eval $(generic-package))
