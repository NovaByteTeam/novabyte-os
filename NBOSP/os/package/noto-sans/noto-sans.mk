NOTO_SANS_VERSION = ffebf8c1ee449e544955a7e813c54f9b73848eac
NOTO_SANS_SITE = https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_SANS_VERSION)/hinted/ttf/NotoSans
NOTO_SANS_SOURCE = NotoSans-Regular.ttf
NOTO_SANS_EXTRA_DOWNLOADS = \
	$(NOTO_SANS_SITE)/NotoSans-Bold.ttf \
	https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_SANS_VERSION)/LICENSE
NOTO_SANS_LICENSE = OFL-1.1
NOTO_SANS_LICENSE_FILES = LICENSE

define NOTO_SANS_EXTRACT_CMDS
	mkdir -p $(@D)
	cp $(NOTO_SANS_DL_DIR)/NotoSans-Regular.ttf $(@D)/NotoSans-Regular.ttf
	cp $(NOTO_SANS_DL_DIR)/NotoSans-Bold.ttf $(@D)/NotoSans-Bold.ttf
	cp $(NOTO_SANS_DL_DIR)/LICENSE $(@D)/LICENSE
endef

define NOTO_SANS_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0644 $(@D)/NotoSans-Regular.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf
	$(INSTALL) -D -m 0644 $(@D)/NotoSans-Bold.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf
	$(INSTALL) -D -m 0644 $(@D)/LICENSE \
		$(TARGET_DIR)/usr/share/licenses/noto-sans/OFL.txt
endef

$(eval $(generic-package))
