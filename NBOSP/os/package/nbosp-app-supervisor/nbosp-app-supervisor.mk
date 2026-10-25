NBOSP_APP_SUPERVISOR_VERSION = 1
NBOSP_APP_SUPERVISOR_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-app-supervisor
NBOSP_APP_SUPERVISOR_SITE_METHOD = local
NBOSP_APP_SUPERVISOR_DEPENDENCIES = libselinux policycoreutils

define NBOSP_APP_SUPERVISOR_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-app-supervisor.c -o $(@D)/nbosp-app-supervisor
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-app-supervisor-service.c -o $(@D)/nbosp-app-supervisor-service
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-init.c -lselinux -o $(@D)/nbosp-init
endef

define NBOSP_APP_SUPERVISOR_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/nbosp-app-supervisor \
		$(TARGET_DIR)/usr/sbin/nbosp-app-supervisor
	$(INSTALL) -D -m 0755 $(@D)/nbosp-app-supervisor-service \
		$(TARGET_DIR)/usr/sbin/nbosp-app-supervisor-service
	$(INSTALL) -D -m 0755 $(@D)/nbosp-init \
		$(TARGET_DIR)/sbin/nbosp-init
	$(INSTALL) -D -m 0644 $(@D)/isolated-app-node-main.js \
		$(TARGET_DIR)/usr/lib/nbosp/isolated-app-node-main.js
	$(INSTALL) -D -m 0755 $(@D)/S12nbosp-app-supervisor \
		$(TARGET_DIR)/etc/init.d/S12nbosp-app-supervisor
endef

$(eval $(generic-package))
