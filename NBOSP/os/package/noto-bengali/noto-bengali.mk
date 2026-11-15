NOTO_BENGALI_VERSION = ffebf8c1ee449e544955a7e813c54f9b73848eac
NOTO_BENGALI_SITE = https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_BENGALI_VERSION)/hinted/ttf/NotoSansBengali
NOTO_BENGALI_SOURCE = NotoSansBengali-Regular.ttf
NOTO_BENGALI_EXTRA_DOWNLOADS = \
	$(NOTO_BENGALI_SITE)/NotoSansBengali-Bold.ttf \
	https://raw.githubusercontent.com/googlefonts/noto-fonts/$(NOTO_BENGALI_VERSION)/LICENSE
NOTO_BENGALI_LICENSE = OFL-1.1
NOTO_BENGALI_LICENSE_FILES = LICENSE

define NOTO_BENGALI_EXTRACT_CMDS
	mkdir -p $(@D)
	cp $(NOTO_BENGALI_DL_DIR)/NotoSansBengali-Regular.ttf $(@D)/NotoSansBengali-Regular.ttf
	cp $(NOTO_BENGALI_DL_DIR)/NotoSansBengali-Bold.ttf $(@D)/NotoSansBengali-Bold.ttf
	cp $(NOTO_BENGALI_DL_DIR)/LICENSE $(@D)/LICENSE
endef

define NOTO_BENGALI_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0644 $(@D)/NotoSansBengali-Regular.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf
	$(INSTALL) -D -m 0644 $(@D)/NotoSansBengali-Bold.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf
	$(INSTALL) -D -m 0644 $(@D)/LICENSE \
		$(TARGET_DIR)/usr/share/licenses/noto-bengali/OFL.txt
endef

$(eval $(generic-package))
